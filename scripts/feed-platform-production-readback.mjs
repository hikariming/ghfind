// Authenticated GET-only release readback; no lifecycle/SQL/business writes.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { ACCOUNT } from "./feed-platform-manifest.mjs";
import { boundedJSON } from "./feed-platform-web-verify.mjs";
import {
  repository,
  runtimeConfigPath,
  requireThat,
  releaseIdentity,
  expectedBindings,
  validateReadiness,
} from "./feed-platform-production.mjs";

export const limits = Object.freeze({
  durationMs: 180000,
  readinessRequests: 75,
  metadataReads: 13,
  intervalMs: 2500,
  requestMs: 10000,
  metadataMs: 30000,
});
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const shortIdentity = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
function scalarVersion(v) {
  return (
    (Number.isSafeInteger(v) && v >= 0) ||
    (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(v))
  );
}
export function activeVersion(active) {
  const d = active?.deployments?.[0];
  requireThat(
    uuid.test(d?.id) &&
      d.versions?.length === 1 &&
      d.versions[0].percentage === 100 &&
      uuid.test(d.versions[0].version_id),
    "single 100% active deployment required",
  );
  return { deploymentId: d.id, versionId: d.versions[0].version_id };
}
export function verifyVersion(
  m,
  sha,
  image,
  mode,
  role,
  active,
  version,
  exposure,
) {
  const identity = activeVersion(active),
    worker = role === "runtime" ? m.runtimeWorker : m.adapterWorker;
  requireThat(
    version?.id === identity.versionId &&
      version.annotations?.["workers/tag"] === `production-${sha}`,
    `${role} exact source tag/version differs`,
  );
  const expected = expectedBindings(m, sha, image, mode, role),
    bindings = version.resources?.bindings;
  requireThat(
    Array.isArray(bindings) &&
      bindings.length === expected.length &&
      new Set(bindings.map((b) => b.name)).size === bindings.length,
    `${role} binding population differs`,
  );
  for (const row of expected) {
    const actual = bindings.find((b) => b.name === row.name);
    requireThat(
      actual && Object.entries(row).every(([k, v]) => actual[k] === v),
      `${role} binding differs: ${row.name}`,
    );
    if (row.type === "service")
      requireThat(
        actual.entrypoint === undefined &&
          (!actual.environment || actual.environment === "production"),
        "runtime service environment/entrypoint differs",
      );
    if (row.type === "durable_object_namespace")
      requireThat(
        (!actual.script_name || actual.script_name === worker) &&
          /^[a-f0-9-]{32,64}$/.test(actual.namespace_id),
        "foreign or unidentifiable Durable Object namespace refused",
      );
  }
  requireThat(
    version.resources?.script_runtime?.compatibility_date === "2026-09-08" &&
      version.resources.script_runtime.compatibility_flags?.includes(
        "nodejs_compat",
      ) &&
      typeof version.resources.script?.etag === "string" &&
      version.resources.script.etag.length > 0 &&
      version.resources.script.etag.length <= 256,
    `${role} script identity missing`,
  );
  requireThat(
    exposure?.enabled === (role === "runtime") &&
      exposure.previews_enabled === false,
    `${role} workers.dev exposure differs`,
  );
  return {
    worker,
    ...identity,
    durableNamespaces: bindings
      .filter((b) => b.type === "durable_object_namespace")
      .map((b) => ({ className: b.class_name, namespaceId: b.namespace_id })),
    tag: `production-${sha}`,
    scriptEtag: version.resources.script.etag,
    bindingIdentitySHA256: createHash("sha256")
      .update(JSON.stringify(expected))
      .digest("hex"),
  };
}
export async function wranglerMetadata(args, { signal }) {
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "CLOUDFLARE_API_TOKEN"]
      .filter((k) => typeof process.env[k] === "string")
      .map((k) => [k, process.env[k]]),
  );
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(
      resolve(repository, "platform/runtime/node_modules/.bin/wrangler"),
      [...args, "--config", runtimeConfigPath],
      {
        cwd: repository,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: limits.metadataMs,
        signal,
        killSignal: "SIGTERM",
        env: {
          ...env,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          CI: "true",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    ));
  } catch {
    signal.throwIfAborted();
    throw new Error("Container metadata subprocess failed");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Invalid Container metadata JSON");
  }
}
export async function verifyDeployment(
  m,
  sha,
  image,
  mode,
  {
    secret,
    token,
    fetcher = fetch,
    metadata = wranglerMetadata,
    limits: narrower = {},
  } = {},
) {
  const identity = releaseIdentity(m, sha, image, mode);
  requireThat(
    typeof secret === "string" &&
      Buffer.byteLength(secret) >= 32 &&
      !/[\x00-\x20\x7f]/.test(secret),
    "dedicated runtime admin secret required",
  );
  requireThat(
    typeof token === "string" &&
      token.length > 0 &&
      token !== secret &&
      !/[\x00-\x20\x7f]/.test(token),
    "separate Cloudflare metadata token required",
  );
  const bounds = { ...limits, ...narrower };
  requireThat(
    Object.keys(bounds).length === Object.keys(limits).length &&
      Object.keys(limits).every(
        (k) =>
          Number.isSafeInteger(bounds[k]) &&
          bounds[k] > 0 &&
          bounds[k] <= limits[k],
      ),
    "readback limits may only be tightened",
  );
  const run = new AbortController(),
    heartbeat = new AbortController(),
    started = performance.now();
  const timer = setTimeout(
    () => run.abort(new Error("production readback deadline exceeded")),
    bounds.durationMs,
  );
  let metadataReads = 0,
    readinessRequests = 0,
    lastReadiness,
    loop,
    heartbeatFailure;
  function signal(timeout, extra = run.signal) {
    return AbortSignal.any([run.signal, extra, AbortSignal.timeout(timeout)]);
  }
  function countMetadata() {
    run.signal.throwIfAborted();
    requireThat(
      ++metadataReads <= bounds.metadataReads,
      "metadata read budget exhausted",
    );
  }
  async function api(path) {
    countMetadata();
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: signal(bounds.metadataMs),
      },
    );
    requireThat(response.ok, `platform metadata HTTP ${response.status}`);
    const data = await boundedJSON(response);
    requireThat(data.success === true, "platform metadata read failed");
    run.signal.throwIfAborted();
    return data.result;
  }
  async function wrangler(args) {
    countMetadata();
    const result = await metadata(args, { signal: signal(bounds.metadataMs) });
    run.signal.throwIfAborted();
    return result;
  }
  async function ready(workerVersionId, extra = run.signal) {
    run.signal.throwIfAborted();
    requireThat(
      ++readinessRequests <= bounds.readinessRequests,
      "readiness request budget exhausted",
    );
    const response = await fetcher(new URL("/readyz", m.runtimeOrigin), {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${secret}` },
      signal: signal(bounds.requestMs, extra),
    });
    requireThat(response.ok, `runtime readiness HTTP ${response.status}`);
    lastReadiness = validateReadiness(
      await boundedJSON(response, 16384),
      m,
      sha,
      image,
      mode,
      workerVersionId,
    );
    run.signal.throwIfAborted();
  }
  try {
    // Obtain the expected Worker ID before waking Containers; once awake, keep
    // the 10s executor alive only for this bounded metadata window.
    const runtimeActive = await api(
      `/workers/scripts/${m.runtimeWorker}/deployments`,
    );
    const runtimeId = activeVersion(runtimeActive).versionId;
    await ready(runtimeId); // no retry loop that can keep an old off process alive
    loop = (async () => {
      try {
        while (!heartbeat.signal.aborted) {
          await sleep(bounds.intervalMs, undefined, {
            signal: heartbeat.signal,
          });
          await ready(runtimeId, heartbeat.signal);
        }
      } catch (error) {
        if (
          !heartbeat.signal.aborted ||
          (error !== heartbeat.signal.reason &&
            error?.cause !== heartbeat.signal.reason)
        ) {
          heartbeatFailure = error;
          run.abort(error);
        }
      }
    })();
    const runtime = verifyVersion(
      m,
      sha,
      image,
      mode,
      "runtime",
      runtimeActive,
      await api(`/workers/scripts/${m.runtimeWorker}/versions/${runtimeId}`),
      await api(`/workers/scripts/${m.runtimeWorker}/subdomain`),
    );
    const adapterActive = await api(
      `/workers/scripts/${m.adapterWorker}/deployments`,
    );
    const adapterId = activeVersion(adapterActive).versionId;
    const adapter = verifyVersion(
      m,
      sha,
      image,
      mode,
      "adapter",
      adapterActive,
      await api(`/workers/scripts/${m.adapterWorker}/versions/${adapterId}`),
      await api(`/workers/scripts/${m.adapterWorker}/subdomain`),
    );
    const apps = await wrangler(["containers", "list", "--json"]);
    requireThat(Array.isArray(apps), "invalid application inventory");
    const applications = [];
    for (const [suffix, names] of [
      ["feedapi", ["api-0", "api-1"]],
      ["feedexecutor", ["executor-0"]],
    ]) {
      const matches = apps.filter(
          (a) => a.name === `${m.runtimeWorker}-${suffix}`,
        ),
        app = matches[0];
      requireThat(
        matches.length === 1 &&
          uuid.test(app.id) &&
          app.image === image &&
          app.state === "active" &&
          scalarVersion(app.version),
        "immutable application not active",
      );
      const configuration = await wrangler([
        "containers",
        "info",
        app.id,
        "--json",
      ]);
      const basic =
        configuration.configuration?.instance_type === "basic" ||
        (configuration.configuration?.vcpu === 0.25 &&
          configuration.configuration?.memory_mib === 1024 &&
          configuration.configuration?.disk?.size_mb === 4000);
      requireThat(
        configuration.id === app.id &&
          configuration.name === app.name &&
          configuration.configuration?.image === image &&
          configuration.max_instances === names.length &&
          basic,
        "actual application capacity/image differs",
      );
      const namespaceId = runtime.durableNamespaces.find(
        (d) =>
          d.className === (suffix === "feedapi" ? "FeedAPI" : "FeedExecutor"),
      )?.namespaceId;
      requireThat(
        namespaceId &&
          configuration.durable_objects?.namespace_id === namespaceId,
        "application is not linked to runtime namespace",
      );
      const result = await wrangler([
        "containers",
        "instances",
        app.id,
        "--per-page",
        "10",
        "--json",
      ]);
      requireThat(
        !result.result_info?.next_page_token &&
          result.instances?.length === names.length,
        "unexpected instance population",
      );
      for (const name of names) {
        const rows = result.instances.filter((i) => i.name === name);
        requireThat(
          rows.length === 1 &&
            shortIdentity(rows[0].id) &&
            rows[0].state === "running" &&
            scalarVersion(rows[0].version) &&
            String(rows[0].version) === String(app.version),
          `instance version/state differs: ${name}`,
        );
      }
      applications.push({
        applicationId: app.id,
        name: app.name,
        image,
        version: app.version,
        instanceType: "basic",
        maxInstances: names.length,
        namespaceId,
        instances: result.instances.map((i) => ({
          id: i.id,
          name: i.name,
          state: i.state,
          version: i.version,
        })),
      });
    }
    for (const prior of [runtime, adapter]) {
      const after = activeVersion(
        await api(`/workers/scripts/${prior.worker}/deployments`),
      );
      requireThat(
        after.deploymentId === prior.deploymentId &&
          after.versionId === prior.versionId,
        "deployment changed during readback",
      );
    }
    heartbeat.abort();
    await loop;
    if (heartbeatFailure) throw heartbeatFailure;
    await ready(runtimeId);
    return {
      format: "ghfind-feed-production-readiness-v1",
      status: "passed",
      accountId: ACCOUNT,
      environment: "production",
      ...identity,
      observedAt: new Date().toISOString(),
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      runtime,
      adapter,
      applications,
      readiness: lastReadiness,
      bindingsVerified: true,
      keepWarm: {
        completed: true,
        stopped: true,
        durationMs: Math.round(performance.now() - started),
        readinessRequests,
        metadataReads,
        limits: bounds,
      },
      notProven: [
        "real OAuth",
        "production Feed journey",
        "queue delivery and DLQ recovery",
        "load or cold-start SLO",
        "monthly cost or availability",
        "migration safety",
      ],
      note: "Read-only exact release readiness. Bootstrap off is not an application rollback; baseline must be separately deployed and read back.",
    };
  } catch (error) {
    throw heartbeatFailure ?? (run.signal.aborted ? run.signal.reason : error);
  } finally {
    heartbeat.abort();
    run.abort();
    clearTimeout(timer);
    await loop;
  }
}
