// Authenticated GET-only release readback; no lifecycle/SQL/business writes.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { ACCOUNT, validateImage } from "./feed-platform-manifest.mjs";
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
  // Initial retries consume time before heartbeats begin and share this quota.
  readinessRequests: 95,
  initialReadinessAttempts: 8,
  initialReadinessIntervalMs: 2500,
  initialReadinessConvergenceMs: 60000,
  // Original 23 + 14 instance retries + 14 application retries + final identity read.
  metadataReads: 52,
  applicationAttempts: 8,
  applicationIntervalMs: 2500,
  applicationConvergenceMs: 60000,
  instanceAttempts: 8,
  instanceIntervalMs: 2500,
  instanceConvergenceMs: 60000,
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
function numericVersion(value) {
  return Number.isSafeInteger(value) ||
    (typeof value === "string" && /^\d+$/.test(value))
    ? BigInt(value)
    : null;
}
function versionAdvanced(current, previous) {
  if (String(current) === String(previous)) return false;
  const next = numericVersion(current),
    before = numericVersion(previous);
  return next === null || before === null || next > before;
}
function sameImageVersionAllowed(current, previous) {
  if (String(current) === String(previous)) return true;
  const next = numericVersion(current),
    before = numericVersion(previous);
  // Same-image rollout may keep its version or numerically advance it. An
  // opaque change cannot establish order and must not authorize rollback.
  return next !== null && before !== null && next >= before;
}
const applicationStates = new Set([
  "active",
  "ready",
  "provisioning",
  "degraded",
  "unknown",
]);
export function validatePreviousApplications(apps, m) {
  requireThat(Array.isArray(apps), "previous applications must be an array");
  const previous = new Map(),
    ids = new Set();
  for (const suffix of ["feedapi", "feedexecutor"]) {
    const name = `${m.runtimeWorker}-${suffix}`;
    const rows = apps.filter((a) => a?.name === name);
    requireThat(rows.length <= 1, "duplicate previous application");
    if (!rows.length) continue; // First install grants no old-image permission.
    const app = rows[0];
    requireThat(
      uuid.test(app.id) && scalarVersion(app.version) && !ids.has(app.id),
      "invalid previous application identity",
    );
    validateImage(app.image);
    ids.add(app.id);
    previous.set(name, {
      id: app.id,
      name,
      version: app.version,
      image: app.image,
    });
  }
  return previous;
}
function inspectApplication(apps, name, image, prior, previous) {
  const matches = Array.isArray(apps)
    ? apps.filter((a) => a?.name === name)
    : [];
  const app = matches[0];
  let reason = null;
  if (!Array.isArray(apps) || matches.length !== 1)
    reason = "application_population_invalid";
  else if (!uuid.test(app.id) || !scalarVersion(app.version))
    reason = "application_identity_invalid";
  else if (previous && app.id !== previous.id)
    reason = "application_identity_changed";
  else if (!["active", "ready", "provisioning"].includes(app.state))
    reason = "application_health_rejected";
  else if (app.image !== image) {
    if (
      !prior &&
      previous &&
      app.image === previous.image &&
      String(app.version) === String(previous.version)
    )
      return {
        app,
        matches,
        status: "pending",
        reason: "prior_application_pending",
      };
    reason = "application_image_changed";
  } else if (
    prior &&
    (app.id !== prior.id || String(app.version) !== String(prior.version))
  )
    reason = "application_identity_changed";
  else if (
    previous &&
    previous.image !== image &&
    !versionAdvanced(app.version, previous.version)
  )
    reason = "application_version_not_advanced";
  else if (
    previous &&
    previous.image === image &&
    !sameImageVersionAllowed(app.version, previous.version)
  )
    reason = "application_version_regressed_or_unordered";
  if (reason) return { app, matches, status: "rejected", reason };
  return {
    app,
    matches,
    status: app.state === "provisioning" ? "pending" : "converged",
    reason: app.state === "provisioning" ? "application_provisioning" : null,
  };
}
function observedApplications(matches, name) {
  return matches.slice(0, 2).map((app) => ({
    id: uuid.test(app?.id) ? app.id : null,
    name: app?.name === name ? app.name : null,
    state: applicationStates.has(app?.state) ? app.state : "invalid",
    version: scalarVersion(app?.version) ? app.version : null,
    imageDigest:
      typeof app?.image === "string"
        ? (/^registry\.cloudflare\.com\/[a-f0-9]{32}\/ghfind-feed@sha256:([a-f0-9]{64})$/.exec(
            app.image,
          )?.[1] ?? null)
        : null,
  }));
}
// CLI placement states from pinned Wrangler 4.129.1 containers/instances.ts.
const instanceStates = new Set([
  "running",
  "inactive",
  "provisioning",
  "stopping",
  "stopped",
  "failed",
  "unhealthy",
  "unknown",
]);
function inspectInstances(result, names, expectedVersion) {
  if (
    !result ||
    !Array.isArray(result.instances) ||
    !result.result_info ||
    typeof result.result_info !== "object" ||
    Array.isArray(result.result_info) ||
    result.result_info.next_page_token ||
    result.instances.length !== names.length
  )
    return { status: "rejected", reason: "unexpected_instance_population" };
  const ids = new Set();
  let pending = false;
  for (const name of names) {
    const rows = result.instances.filter((i) => i?.name === name);
    if (rows.length !== 1 || !shortIdentity(rows[0].id) || ids.has(rows[0].id))
      return { status: "rejected", reason: "instance_identity_invalid" };
    const row = rows[0];
    ids.add(row.id);
    if (
      !instanceStates.has(row.state) ||
      (row.state === "inactive"
        ? row.version !== null
        : !scalarVersion(row.version))
    )
      return {
        status: "rejected",
        reason: "instance_state_or_version_invalid",
      };
    if (["failed", "unhealthy", "unknown"].includes(row.state))
      return { status: "rejected", reason: "instance_unhealthy" };
    if (
      row.state !== "running" ||
      String(row.version) !== String(expectedVersion)
    )
      pending = true;
  }
  return {
    status: pending ? "pending" : "converged",
    reason: pending ? "instance_state_or_version_pending" : null,
  };
}
function observedInstances(result, names) {
  // Never copy arbitrary rows, names, environment, placement detail or bodies.
  return (Array.isArray(result?.instances) ? result.instances : [])
    .slice(0, names.length)
    .map((row) => ({
      id: shortIdentity(row?.id) ? row.id : null,
      name: names.includes(row?.name) ? row.name : null,
      state: instanceStates.has(row?.state) ? row.state : "invalid",
      version: scalarVersion(row?.version) ? row.version : null,
    }));
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
// GET schemas checked 2026-09-09:
// https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/list/
// https://developers.cloudflare.com/api/resources/queues/methods/get/
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/
// Wrangler 4.129.1 updateQueueConsumers maps max_batch_timeout seconds to
// max_wait_time_ms, and its legacy list responses use script/service instead
// of the documented script_name. Conflicting aliases never select a target.
function queueConsumer(c, queue, deadLetterQueue, runtimeWorker) {
  const names = [c?.script_name, c?.script, c?.service].filter(
    (v) => v !== undefined,
  );
  requireThat(
    c?.type === "worker" &&
      /^[a-f0-9]{32}$/.test(c.consumer_id) &&
      names.length > 0 &&
      names.every((v) => v === runtimeWorker) &&
      (c.queue_name === undefined || c.queue_name === queue) &&
      (c.environment === undefined || c.environment === "production") &&
      (c.service === undefined || c.environment === "production") &&
      c.dead_letter_queue === deadLetterQueue &&
      c.settings?.batch_size === 1 &&
      c.settings.max_concurrency === 1 &&
      c.settings.max_retries === 5 &&
      c.settings.max_wait_time_ms === 5000,
    "production queue consumer policy differs",
  );
  return {
    consumerId: c.consumer_id,
    type: "worker",
    worker: runtimeWorker,
    deadLetterQueue,
    batchSize: 1,
    maxConcurrency: 1,
    maxRetries: 5,
    maxWaitTimeMs: 5000,
  };
}
export async function verifyAsyncTriggers(m, mode, api) {
  requireThat(["off", "baseline"].includes(mode), "unknown asynchronous mode");
  const queues = [],
    seen = new Set();
  for (const [name, deadLetterQueue, retentionSeconds] of [
    [m.queue, m.deadLetterQueue, 345600],
    [m.deadLetterQueue, m.terminalParkingQueue, 345600],
    [m.terminalParkingQueue, null, 1209600],
  ]) {
    const lookup = await api(`/queues?name=${encodeURIComponent(name)}`);
    requireThat(
      Array.isArray(lookup) &&
        lookup.length === 1 &&
        lookup[0]?.queue_name === name &&
        /^[a-f0-9]{32}$/.test(lookup[0].queue_id),
      "production queue missing or ambiguous",
    );
    const queueId = lookup[0].queue_id;
    requireThat(!seen.has(queueId), "production queue IDs must be distinct");
    seen.add(queueId);
    const details = await api(`/queues/${queueId}`);
    const consumers = await api(`/queues/${queueId}/consumers`);
    requireThat(
      details?.queue_id === queueId &&
        details.queue_name === name &&
        Array.isArray(details.consumers) &&
        Array.isArray(consumers) &&
        details.consumers.length === consumers.length &&
        (details.consumers_total_count === undefined ||
          details.consumers_total_count === consumers.length),
      "production queue consumer snapshot incomplete or changed",
    );
    requireThat(
      details.settings?.message_retention_period === retentionSeconds &&
        details.settings.delivery_delay === 0 &&
        details.settings.delivery_paused === false,
      "production queue retention/delivery settings differ",
    );
    // These queues are dedicated to this production runtime. Even a foreign
    // consumer in off is unsafe ownership drift, not an idle bootstrap.
    const wanted = mode === "baseline" && deadLetterQueue !== null ? 1 : 0;
    requireThat(
      consumers.length === wanted,
      "production asynchronous consumer population differs",
    );
    const verified = consumers.map((c) =>
      queueConsumer(c, name, deadLetterQueue, m.runtimeWorker),
    );
    const detailed = details.consumers.map((c) =>
      queueConsumer(c, name, deadLetterQueue, m.runtimeWorker),
    );
    requireThat(
      JSON.stringify(verified) === JSON.stringify(detailed),
      "production queue consumer snapshot changed",
    );
    queues.push({
      name,
      queueId,
      retentionSeconds,
      deliveryDelaySeconds: 0,
      deliveryPaused: false,
      consumers: verified,
    });
  }
  const schedules = await api(`/workers/scripts/${m.runtimeWorker}/schedules`);
  const expected = mode === "baseline" ? ["* * * * *"] : [];
  requireThat(
    Array.isArray(schedules?.schedules) &&
      schedules.schedules.length === expected.length &&
      schedules.schedules.every((row, i) => row?.cron === expected[i]),
    "production cron schedules differ",
  );
  return { verified: true, mode, queues, schedules: expected };
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
    previousApplications,
  } = {},
) {
  const identity = releaseIdentity(m, sha, image, mode);
  const previous =
    previousApplications === undefined
      ? new Map()
      : validatePreviousApplications(previousApplications, m);
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
    heartbeatFailure,
    lastReadinessAt = null,
    stage = "initial_readiness",
    failureReceipt;
  const instanceObservations = [],
    applicationObservations = [],
    readinessObservations = [];
  const expectedApplicationPins = new Map();
  const applicationAttempts = new Map(),
    applicationSequences = new Map();
  let latestApplications,
    latestApplicationsAt,
    applicationSequence = 0;
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
  async function wrangler(args, extra = run.signal) {
    countMetadata();
    const result = await metadata(args, {
      signal: signal(bounds.metadataMs, extra),
    });
    extra.throwIfAborted();
    run.signal.throwIfAborted();
    if (args[0] === "containers" && args[1] === "list") applicationSequence++;
    if (
      previousApplications !== undefined &&
      args[0] === "containers" &&
      args[1] === "list"
    ) {
      latestApplications = result;
      latestApplicationsAt = new Date().toISOString();
      // Every actual list read witnesses both registered apps. Once either
      // reaches the target digest, another app's retry must not hide rollback.
      for (const suffix of ["feedapi", "feedexecutor"]) {
        const name = `${m.runtimeWorker}-${suffix}`;
        const verdict = inspectApplication(
          result,
          name,
          image,
          expectedApplicationPins.get(name),
          previous.get(name),
        );
        if (verdict.status === "rejected") {
          observeApplication(
            result,
            name,
            expectedApplicationPins.get(name),
            latestApplicationsAt,
            "snapshot",
            null,
          );
          throw new Error(
            `immutable application identity or health summary differs: ${verdict.reason}`,
          );
        }
        if (verdict.app.image === image)
          expectedApplicationPins.set(name, {
            id: verdict.app.id,
            version: verdict.app.version,
          });
      }
    }
    return result;
  }
  async function ready(
    workerVersionId,
    extra = run.signal,
    phase = "strict",
    attempt = null,
  ) {
    run.signal.throwIfAborted();
    requireThat(
      ++readinessRequests <= bounds.readinessRequests,
      "readiness request budget exhausted",
    );
    const requestSignal = signal(bounds.requestMs, extra);
    const response = await fetcher(new URL("/readyz", m.runtimeOrigin), {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${secret}` },
      signal: requestSignal,
    });
    const observation = {
      observedAt: new Date().toISOString(),
      phase,
      attempt,
      status: response.status,
      errorCode: null,
    };
    readinessObservations.push(observation);
    if (!response.ok) {
      // Closed code list, never arbitrary upstream messages, body or headers.
      const codes = new Set([
        "container_dependency_not_ready",
        "container_not_ready",
        "container_version_or_contract_mismatch",
        "runtime_unconfigured",
        "unauthorized",
        "feed_unavailable",
        "not_found",
        "method_not_allowed",
      ]);
      try {
        requireThat(
          response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json"),
          "readiness error is not JSON",
        );
        const data = await readinessJSON(response, requestSignal);
        if (codes.has(data?.error)) observation.errorCode = data.error;
      } catch {
        /* HTTP status remains useful even for non-JSON/error bodies. */
      }
      throw Object.assign(
        new Error(`runtime readiness HTTP ${response.status}`),
        {
          readinessHTTP: {
            status: response.status,
            errorCode: observation.errorCode,
          },
        },
      );
    }
    lastReadiness = validateReadiness(
      await readinessJSON(response, requestSignal),
      m,
      sha,
      image,
      mode,
      workerVersionId,
    );
    run.signal.throwIfAborted();
    lastReadinessAt = new Date().toISOString();
  }
  async function readinessJSON(response, requestSignal) {
    requestSignal.throwIfAborted();
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(requestSignal.reason);
      requestSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([boundedJSON(response, 16384), aborted]);
    } finally {
      requestSignal.removeEventListener("abort", onAbort);
    }
  }
  async function initialReady(workerVersionId) {
    const convergence = AbortSignal.any([
      run.signal,
      AbortSignal.timeout(bounds.initialReadinessConvergenceMs),
    ]);
    for (
      let attempt = 1;
      attempt <= bounds.initialReadinessAttempts;
      attempt++
    ) {
      convergence.throwIfAborted();
      try {
        await ready(workerVersionId, convergence, "initial", attempt);
        convergence.throwIfAborted();
        return;
      } catch (error) {
        if (
          error.readinessHTTP?.status !== 503 ||
          error.readinessHTTP.errorCode !== "container_dependency_not_ready"
        )
          throw error;
        requireThat(
          attempt < bounds.initialReadinessAttempts,
          "initial dependency readiness attempts exhausted",
        );
      }
      await sleep(bounds.initialReadinessIntervalMs, undefined, {
        signal: convergence,
      });
    }
  }
  function observeApplication(apps, name, prior, observedAt, phase, attempt) {
    const verdict = inspectApplication(
      apps,
      name,
      image,
      expectedApplicationPins.get(name) ?? prior,
      previous.get(name),
    );
    applicationObservations.push({
      observedAt,
      phase,
      attempt,
      applicationName: name,
      status: verdict.status,
      reason: verdict.reason,
      matchCount: verdict.matches.length,
      applications: observedApplications(verdict.matches, name),
    });
    return verdict;
  }
  async function convergeApplication(
    initialApps,
    initialObservedAt,
    name,
    convergence,
    identityOnly = false,
    initialSequence = applicationSequence,
  ) {
    let apps = initialApps,
      observedAt = initialObservedAt,
      prior,
      sequence = initialSequence;
    for (;;) {
      convergence.throwIfAborted();
      let attempt = applicationAttempts.get(name) ?? 0,
        verdict;
      if (applicationSequences.get(name) !== sequence) {
        requireThat(
          attempt < bounds.applicationAttempts,
          `application summary convergence attempts exhausted: ${name}`,
        );
        applicationAttempts.set(name, ++attempt);
        applicationSequences.set(name, sequence);
        verdict = observeApplication(
          apps,
          name,
          prior,
          observedAt,
          identityOnly ? "identity" : "convergence",
          attempt,
        );
      } else {
        // The same cached identity snapshot can be rechecked after ready. It
        // neither resets attempts nor counts as another actual metadata read.
        verdict = inspectApplication(
          apps,
          name,
          image,
          expectedApplicationPins.get(name) ?? prior,
          previous.get(name),
        );
      }
      requireThat(
        verdict.status !== "rejected",
        `immutable application identity or health summary differs: ${verdict.reason}`,
      );
      // The first target-image identity is pinned even while provisioning. A new
      // version/UUID/digest never resets the bounded convergence window.
      if (verdict.app.image === image)
        prior ??= { id: verdict.app.id, version: verdict.app.version };
      if (
        verdict.status === "converged" ||
        (identityOnly && verdict.app.image === image)
      )
        return verdict.app;
      requireThat(
        attempt < bounds.applicationAttempts,
        `application summary convergence attempts exhausted: ${name}`,
      );
      await sleep(bounds.applicationIntervalMs, undefined, {
        signal: convergence,
      });
      apps = await wrangler(["containers", "list", "--json"], convergence);
      observedAt = new Date().toISOString();
      sequence = applicationSequence;
    }
  }
  // Deploy returns before every instance is replaced; metadata may still be
  // transitional. https://developers.cloudflare.com/containers/guides/deploy/
  async function convergeInstances(app, names, runtimeId) {
    const convergence = AbortSignal.any([
      run.signal,
      AbortSignal.timeout(bounds.instanceConvergenceMs),
    ]);
    for (let attempt = 1; attempt <= bounds.instanceAttempts; attempt++) {
      convergence.throwIfAborted();
      // A stale placement snapshot is retryable; a stale actual Go process is not.
      await ready(runtimeId, convergence);
      convergence.throwIfAborted();
      const result = await wrangler(
        ["containers", "instances", app.id, "--per-page", "10", "--json"],
        convergence,
      );
      const verdict = inspectInstances(result, names, app.version);
      instanceObservations.push({
        observedAt: new Date().toISOString(),
        applicationId: app.id,
        applicationName: app.name,
        applicationVersion: app.version,
        applicationSummary: app.state,
        attempt,
        readinessObservedAt: lastReadinessAt,
        ...verdict,
        instances: observedInstances(result, names),
      });
      requireThat(
        verdict.status !== "rejected",
        `instance version/state differs or unexpected instance population: ${verdict.reason}`,
      );
      if (verdict.status === "converged") return result;
      requireThat(
        attempt < bounds.instanceAttempts,
        `instance version/state differs: convergence attempts exhausted for ${names.join(",")}`,
      );
      await sleep(bounds.instanceIntervalMs, undefined, {
        signal: convergence,
      });
    }
  }
  try {
    // Obtain the expected Worker ID before waking Containers; once awake, keep
    // the 10s executor alive only for this bounded metadata window.
    const runtimeActive = await api(
      `/workers/scripts/${m.runtimeWorker}/deployments`,
    );
    const runtimeId = activeVersion(runtimeActive).versionId;
    stage = "platform_identity";
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
    let applicationConvergence,
      apps,
      appsObservedAt,
      initialApplicationSequence;
    const identitySnapshots = new Map();
    if (previousApplications !== undefined) {
      stage = "application_identity_convergence";
      applicationConvergence = AbortSignal.any([
        run.signal,
        AbortSignal.timeout(bounds.applicationConvergenceMs),
      ]);
      apps = await wrangler(
        ["containers", "list", "--json"],
        applicationConvergence,
      );
      appsObservedAt = latestApplicationsAt;
      initialApplicationSequence = applicationSequence;
      for (const suffix of ["feedapi", "feedexecutor"]) {
        const app = await convergeApplication(
          latestApplications,
          latestApplicationsAt,
          `${m.runtimeWorker}-${suffix}`,
          applicationConvergence,
          true,
          applicationSequence,
        );
        if (["active", "ready"].includes(app.state))
          identitySnapshots.set(app.name, {
            apps: latestApplications,
            observedAt: latestApplicationsAt,
            sequence: applicationSequence,
          });
      }
    }
    // Verify both fixed Worker configurations before trusting the protected
    // dependency-only code. An old process/unknown 503 never grants a retry.
    stage = "initial_readiness";
    await initialReady(runtimeId);
    loop = (async () => {
      try {
        while (!heartbeat.signal.aborted) {
          await sleep(bounds.intervalMs, undefined, {
            signal: heartbeat.signal,
          });
          await ready(runtimeId, heartbeat.signal, "heartbeat");
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
    stage = "application_convergence";
    // Start before the first shared metadata request. Both summaries settle
    // within this same 60s window, before inspecting any instance; the overall
    // 180s timer still governs all later work. No cached first read is uncounted.
    if (!applicationConvergence) {
      applicationConvergence = AbortSignal.any([
        run.signal,
        AbortSignal.timeout(bounds.applicationConvergenceMs),
      ]);
      apps = await wrangler(
        ["containers", "list", "--json"],
        applicationConvergence,
      );
      appsObservedAt = new Date().toISOString();
      initialApplicationSequence = applicationSequence;
    }
    const settledApplications = [];
    for (const [suffix, names] of [
      ["feedapi", ["api-0", "api-1"]],
      ["feedexecutor", ["executor-0"]],
    ]) {
      // Wrangler 4.129.1 derives the summary from health counters. Provisioning
      // may be observed during rollout, but is never accepted as successful.
      const name = `${m.runtimeWorker}-${suffix}`;
      const knownHealthy = identitySnapshots.get(name);
      const app = await convergeApplication(
        knownHealthy?.apps ?? latestApplications ?? apps,
        knownHealthy?.observedAt ?? latestApplicationsAt ?? appsObservedAt,
        name,
        applicationConvergence,
        false,
        knownHealthy?.sequence ??
          (latestApplications
            ? applicationSequence
            : initialApplicationSequence),
      );
      settledApplications.push({ app, suffix, names });
    }
    const applications = [];
    for (const { app, suffix, names } of settledApplications) {
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
      stage = "instance_convergence";
      const result = await convergeInstances(app, names, runtimeId);
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
    stage = "async_triggers";
    const asyncTriggers = await verifyAsyncTriggers(m, mode, api);
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
    stage = "final_application_identity";
    const finalApps = await wrangler(["containers", "list", "--json"]);
    const finalAppsObservedAt = new Date().toISOString();
    for (const prior of applications) {
      const verdict = observeApplication(
        finalApps,
        prior.name,
        { id: prior.applicationId, version: prior.version },
        finalAppsObservedAt,
        "final",
        null,
      );
      requireThat(
        verdict.status === "converged",
        "application changed during readback",
      );
    }
    heartbeat.abort();
    await loop;
    if (heartbeatFailure) throw heartbeatFailure;
    stage = "final_readiness";
    await ready(runtimeId, run.signal, "final");
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
      instanceObservations,
      applicationObservations,
      readinessObservations,
      previousApplications: [...previous.values()],
      readiness: lastReadiness,
      bindingsVerified: true,
      asyncTriggers,
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
    const failure =
      heartbeatFailure ?? (run.signal.aborted ? run.signal.reason : error);
    failureReceipt = {
      format: "ghfind-feed-production-readback-failure-v1",
      status: "failed",
      failureCode: "production_readback_failed",
      stage,
      accountId: ACCOUNT,
      environment: "production",
      ...identity,
      observedAt: new Date().toISOString(),
      readinessObservedAt: lastReadinessAt,
      instanceObservations,
      applicationObservations,
      readinessObservations,
      previousApplications: [...previous.values()],
      // Only validateReadiness's approved projection; never an unchecked response.
      lastValidatedReadiness: lastReadiness ?? null,
      keepWarm: {
        completed: false,
        stopped: false,
        durationMs: Math.round(performance.now() - started),
        readinessRequests,
        metadataReads,
        limits: bounds,
      },
      note: "Failed diagnostic only. Does not authorize baseline or traffic admission.",
    };
    failure.readbackFailure = failureReceipt;
    throw failure;
  } finally {
    heartbeat.abort();
    run.abort();
    clearTimeout(timer);
    await loop;
    if (failureReceipt) failureReceipt.keepWarm.stopped = true;
  }
}
