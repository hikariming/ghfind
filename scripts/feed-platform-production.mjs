#!/usr/bin/env node
// Production has a separate pinned contract. Never pass these IDs through the
// staging validator or relax its production/dev denylist.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  ACCOUNT,
  validateImage,
  secretNames,
  adapterSecretNames,
} from "./feed-platform-manifest.mjs";

export const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const runtimeConfigPath = resolve(
  repository,
  "platform/runtime/wrangler.production.generated.json",
);
export const adapterConfigPath = resolve(
  repository,
  "platform/runtime/wrangler.adapter.production.generated.json",
);
export const production = Object.freeze({
  runtimeWorker: "ghfind-feed-runtime-production",
  adapterWorker: "ghfind-feed-adapter-production",
  runtimeOrigin:
    "https://ghfind-feed-runtime-production.beiming1201.workers.dev",
  coreDatabase: { name: "ghfind", id: "60d45096-bfe7-4de1-8b85-c1b66a466b0d" },
  feedDatabase: {
    name: "ghfind-feed",
    id: "9c4ac13a-4c90-40a8-9d56-d7141f864bbf",
  },
  archiveBucket: "ghfind-feed-production-archive",
  queue: "ghfind-feed-production-jobs",
  deadLetterQueue: "ghfind-feed-production-dlq",
  terminalParkingQueue: "ghfind-feed-production-terminal-parking",
});
export { secretNames, adapterSecretNames };
export function template() {
  return {
    schemaVersion: 1,
    environment: "production",
    accountId: ACCOUNT,
    ...structuredClone(production),
    writerEpoch: 1,
    billing: {
      confirmed: false,
      evidence: null,
      maximumMonthlyUSD: 100,
      projectedMonthlyUSD: null,
    },
  };
}
export function requireThat(value, message) {
  if (!value) throw new Error(message);
}
function exact(value, keys, label) {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      Object.keys(value).every((k) => keys.includes(k)),
    `unexpected ${label} fields`,
  );
}
export function validateManifest(m) {
  exact(m, Object.keys(template()), "production manifest");
  requireThat(
    m.schemaVersion === 1 &&
      m.environment === "production" &&
      m.accountId === ACCOUNT,
    "unexpected production account/environment/version",
  );
  for (const [key, value] of Object.entries(production)) {
    if (typeof value === "string")
      requireThat(m[key] === value, `production ${key} is pinned`);
    else {
      exact(m[key], ["name", "id"], key);
      requireThat(
        m[key].name === value.name && m[key].id === value.id,
        `production ${key} is pinned`,
      );
    }
  }
  requireThat(
    Number.isSafeInteger(m.writerEpoch) && m.writerEpoch > 0,
    "positive safe writer epoch required",
  );
  exact(
    m.billing,
    ["confirmed", "evidence", "maximumMonthlyUSD", "projectedMonthlyUSD"],
    "billing",
  );
  let evidence;
  try {
    evidence = new URL(m.billing.evidence);
  } catch {
    /* rejected below */
  }
  requireThat(
    m.billing.confirmed === true &&
      evidence?.protocol === "https:" &&
      !evidence.username &&
      !evidence.password &&
      !evidence.search &&
      m.billing.maximumMonthlyUSD === 100 &&
      typeof m.billing.projectedMonthlyUSD === "number" &&
      m.billing.projectedMonthlyUSD > 0 &&
      m.billing.projectedMonthlyUSD <= 80,
    "paid-plan evidence and <=80 USD estimate within 100 USD budget required",
  );
  return m;
}
export function manifestHash(m) {
  validateManifest(m);
  // Fixed ASCII keys/order; no arbitrary JSON canonicalization is implied.
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.keys(template()).map((key) => [
            key,
            key === "billing"
              ? Object.fromEntries(
                  [
                    "confirmed",
                    "evidence",
                    "maximumMonthlyUSD",
                    "projectedMonthlyUSD",
                  ].map((k) => [k, m.billing[k]]),
                )
              : key.endsWith("Database")
                ? { name: m[key].name, id: m[key].id }
                : m[key],
          ]),
        ),
      ),
    )
    .digest("hex");
}
export function releaseIdentity(m, sha, image, mode) {
  validateManifest(m);
  validateImage(image);
  requireThat(/^[a-f0-9]{40}$/.test(sha), "exact source SHA required");
  requireThat(
    ["off", "baseline"].includes(mode),
    "only off or baseline modes are supported",
  );
  return {
    sourceSha: sha,
    image,
    mode,
    writerEpoch: m.writerEpoch,
    manifestSHA256: manifestHash(m),
  };
}
function runtimeConfiguration(m, image, sha, mode) {
  releaseIdentity(m, sha, image, mode);
  const c = JSON.parse(
    readFileSync(
      resolve(repository, "platform/runtime/wrangler.jsonc"),
      "utf8",
    ),
  );
  c.name = m.runtimeWorker;
  c.account_id = ACCOUNT;
  c.workers_dev = true;
  c.preview_urls = false;
  c.vars = {
    ...c.vars,
    FEED_ENVIRONMENT: "production",
    FEED_RELEASE_SHA: sha,
    FEED_IMAGE_REFERENCE: image,
    FEED_MODE: mode,
    FEED_WRITER_EPOCH: String(m.writerEpoch),
    FEED_EXECUTOR_ENABLED: "true",
    FEED_SOURCE_RELAY_ENABLED: mode === "baseline" ? "true" : "false",
    FEED_QUEUE_NAME: m.queue,
    FEED_DLQ_NAME: m.deadLetterQueue,
  };
  c.services = [{ binding: "FEED_ADAPTER", service: m.adapterWorker }];
  c.containers = ["FeedAPI", "FeedExecutor"].map((class_name) => ({
    class_name,
    name: `${m.runtimeWorker}-${class_name.toLowerCase()}`,
    image,
    instance_type: "basic",
    max_instances: class_name === "FeedAPI" ? 2 : 1,
  }));
  c.queues = {
    producers: [{ binding: "FEED_JOBS_QUEUE", queue: m.queue }],
    ...(mode === "baseline"
      ? {
          consumers: [
            [m.queue, m.deadLetterQueue],
            [m.deadLetterQueue, m.terminalParkingQueue],
          ].map(([queue, dead_letter_queue]) => ({
            queue,
            max_batch_size: 1,
            max_batch_timeout: 5,
            max_retries: 5,
            max_concurrency: 1,
            dead_letter_queue,
          })),
        }
      : {}),
  };
  // Wrangler preserves remote schedules when crons is omitted; an explicit
  // empty array makes the off deployment remove existing schedules.
  c.triggers = { crons: mode === "baseline" ? ["* * * * *"] : [] };
  return c;
}
export function renderAdapter(m, sha) {
  validateManifest(m);
  requireThat(/^[a-f0-9]{40}$/.test(sha), "exact source SHA required");
  const c = JSON.parse(
    readFileSync(resolve(repository, "platform/feed/wrangler.jsonc"), "utf8"),
  );
  requireThat(
    adapterSecretNames.every((name) => c.secrets?.required?.includes(name)),
    "adapter role contracts missing",
  );
  c.name = m.adapterWorker;
  c.account_id = ACCOUNT;
  c.main = "../feed/src/index.ts";
  c.$schema = "./node_modules/wrangler/config-schema.json";
  c.workers_dev = false;
  c.preview_urls = false;
  c.vars = {
    ...c.vars,
    FEED_SEMANTIC_STATE: "disabled",
    FEED_RELEASE_SHA: sha,
  };
  c.d1_databases = [
    ["FEED_DB", m.feedDatabase, "../../migrations-feed"],
    ["CORE_DB", m.coreDatabase, "../../migrations"],
  ].map(([binding, database, migrations_dir]) => ({
    binding,
    database_name: database.name,
    database_id: database.id,
    migrations_dir,
  }));
  c.r2_buckets = [{ binding: "FEED_ARCHIVE", bucket_name: m.archiveBucket }];
  return c;
}
export function validateReceipt(r, m, sha, image, mode, now = Date.now()) {
  const expected = releaseIdentity(m, sha, image, mode);
  requireThat(
    r?.format === "ghfind-feed-production-readiness-v1" &&
      r.status === "passed" &&
      r.accountId === ACCOUNT &&
      r.environment === "production" &&
      Object.entries(expected).every(([k, v]) => r[k] === v),
    "matching production readiness receipt required",
  );
  const age = now - Date.parse(r.observedAt);
  requireThat(
    Number.isFinite(age) && age >= 0 && age <= 15 * 60 * 1000,
    "production readiness receipt expired or future dated",
  );
  requireThat(
    r.bindingsVerified === true &&
      r.keepWarm?.completed === true &&
      r.keepWarm?.stopped === true &&
      r.runtime?.worker === m.runtimeWorker &&
      r.adapter?.worker === m.adapterWorker &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        r.runtime?.versionId,
      ) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        r.adapter?.versionId,
      ),
    "incomplete actual deployment readback",
  );
  requireThat(
    r.asyncTriggers?.verified === true && r.asyncTriggers.mode === mode,
    "actual queue consumers and schedules must be verified",
  );
  requireThat(
    r.applications?.length === 2 && r.readiness?.length === 3,
    "missing actual instance/readiness evidence",
  );
  for (const [suffix, names] of [
    ["feedapi", ["api-0", "api-1"]],
    ["feedexecutor", ["executor-0"]],
  ]) {
    const apps = r.applications.filter(
      (a) => a.name === `${m.runtimeWorker}-${suffix}`,
    );
    requireThat(
      apps.length === 1 &&
        apps[0].image === image &&
        apps[0].instances?.length === names.length &&
        apps[0].version != null &&
        apps[0].instanceType === "basic" &&
        apps[0].maxInstances === names.length,
      "incomplete immutable application identity",
    );
    const className = suffix === "feedapi" ? "FeedAPI" : "FeedExecutor";
    requireThat(
      r.runtime.durableNamespaces?.filter(
        (d) =>
          d.className === className &&
          d.namespaceId === apps[0].namespaceId &&
          typeof d.namespaceId === "string" &&
          /^[a-f0-9-]{32,64}$/.test(d.namespaceId),
      ).length === 1,
      "application namespace identity differs",
    );
    for (const name of names) {
      const instances = apps[0].instances.filter((i) => i.name === name);
      requireThat(
        instances.length === 1 &&
          typeof instances[0].id === "string" &&
          instances[0].id &&
          instances[0].state === "running" &&
          String(instances[0].version) === String(apps[0].version),
        "incomplete running instance identity",
      );
    }
  }
  validateReadiness(
    {
      ready: true,
      service: "feed-runtime",
      version: sha,
      contractVersion: "1",
      mode,
      workerVersionId: r.runtime.versionId,
      configuredImage: image,
      containers: r.readiness,
    },
    m,
    sha,
    image,
    mode,
    r.runtime.versionId,
  );
  // This is a local workflow receipt, not a signed trust anchor. Its creation,
  // retention and consumption must stay in the same serialized Actions run.
  if (process.env.GITHUB_RUN_ID || process.env.GITHUB_RUN_ATTEMPT)
    requireThat(
      r.runId === process.env.GITHUB_RUN_ID &&
        r.runAttempt === process.env.GITHUB_RUN_ATTEMPT,
      "readiness receipt belongs to another Actions run",
    );
  return r;
}
export function renderRuntime(m, image, sha, mode, receipt, now) {
  if (mode === "baseline") validateReceipt(receipt, m, sha, image, "off", now);
  return runtimeConfiguration(m, image, sha, mode);
}
export function expectedBindings(m, sha, image, mode, role) {
  const c =
    role === "runtime"
      ? runtimeConfiguration(m, image, sha, mode)
      : renderAdapter(m, sha);
  return [
    ...Object.entries(c.vars).map(([name, text]) => ({
      name,
      type: "plain_text",
      text,
    })),
    ...c.secrets.required.map((name) => ({ name, type: "secret_text" })),
    ...(c.d1_databases ?? []).map((b) => ({
      name: b.binding,
      type: "d1",
      id: b.database_id,
    })),
    ...(c.r2_buckets ?? []).map((b) => ({
      name: b.binding,
      type: "r2_bucket",
      bucket_name: b.bucket_name,
    })),
    ...(c.services ?? []).map((b) => ({
      name: b.binding,
      type: "service",
      service: b.service,
    })),
    ...(c.durable_objects?.bindings ?? []).map((b) => ({
      name: b.name,
      type: "durable_object_namespace",
      class_name: b.class_name,
    })),
    ...(c.queues?.producers ?? []).map((b) => ({
      name: b.binding,
      type: "queue",
      queue_name: b.queue,
    })),
    ...(c.version_metadata
      ? [{ name: c.version_metadata.binding, type: "version_metadata" }]
      : []),
  ];
}
export function validateReadiness(data, m, sha, image, mode, versionId) {
  requireThat(
    data?.ready === true &&
      data.service === "feed-runtime" &&
      data.version === sha &&
      data.contractVersion === "1" &&
      data.workerVersionId === versionId &&
      data.configuredImage === image &&
      data.mode === mode,
    "runtime readiness identity differs",
  );
  requireThat(
    data.containers?.length === 3,
    "readiness target population differs",
  );
  return ["api-0", "api-1", "executor-0"].map((target) => {
    const rows = data.containers.filter((r) => r.target === target),
      r = rows[0];
    requireThat(
      rows.length === 1 &&
        r.ready === true &&
        r.version === sha &&
        r.contractVersion === "1" &&
        r.storageWriterVersion === 2 &&
        r.storeProfile === "cf_d1_r2" &&
        r.writerEpoch === m.writerEpoch &&
        r.mode === mode &&
        r.service === (target === "executor-0" ? "feed-worker" : "feed-api"),
      `container readiness differs: ${target}`,
    );
    return {
      target,
      ready: true,
      version: sha,
      contractVersion: "1",
      storageWriterVersion: 2,
      storeProfile: "cf_d1_r2",
      writerEpoch: m.writerEpoch,
      mode,
      service: r.service,
    };
  });
}
// Wrangler only adds/updates configured consumers. Omitting a consumer from an
// off deployment does not detach it. Detach owned subscriptions explicitly;
// queues, retained messages and the terminal parking queue are never deleted.
export async function disableConsumers(
  m,
  { env = process.env, fetcher = fetch } = {},
) {
  validateManifest(m);
  const { authorizeMutation } = await import("./feed-production-release.mjs");
  authorizeMutation(env);
  requireThat(
    typeof env.CLOUDFLARE_API_TOKEN === "string" &&
      env.CLOUDFLARE_API_TOKEN.length >= 32,
    "production CF credential missing",
  );
  const signal = AbortSignal.timeout(120000);
  const receipt = {
    format: "ghfind-feed-production-consumers-off-v1",
    status: "incomplete",
    accountId: ACCOUNT,
    runtimeWorker: m.runtimeWorker,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    startedAt: new Date().toISOString(),
    observedAt: null,
    requests: 0,
    queues: [],
    removed: [],
    deleteAttempts: [],
    messagesDeleted: false,
    queuesDeleted: false,
    consumersAbsent: false,
  };
  async function api(path, method = "GET") {
    signal.throwIfAborted();
    requireThat(
      ++receipt.requests <= 14,
      "consumer detach request budget exceeded",
    );
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      },
    );
    const { boundedJSON } = await import("./feed-platform-web-verify.mjs");
    const data = await boundedJSON(response, 65536);
    signal.throwIfAborted();
    requireThat(
      response.ok && data.success === true,
      `consumer detach metadata HTTP ${response.status}`,
    );
    return data.result;
  }
  function owned(rows, name) {
    requireThat(
      Array.isArray(rows) && rows.length <= 1,
      "unexpected consumer population",
    );
    for (const c of rows) {
      const owners = [c?.script_name, c?.script, c?.service].filter(
        (v) => v !== undefined,
      );
      requireThat(
        c?.type === "worker" &&
          /^[a-f0-9]{32}$/.test(c.consumer_id) &&
          owners.length > 0 &&
          owners.every((v) => v === m.runtimeWorker) &&
          (c.queue_name === undefined || c.queue_name === name) &&
          (c.environment === undefined || c.environment === "production") &&
          (c.service === undefined || c.environment === "production"),
        "foreign or ambiguous consumer owner",
      );
    }
    return rows.map((c) => c.consumer_id);
  }
  try {
    // Complete ownership preflight for BOTH queues before the first mutation.
    for (const name of [m.queue, m.deadLetterQueue]) {
      const found = await api(`/queues?name=${encodeURIComponent(name)}`);
      requireThat(
        Array.isArray(found) &&
          found.length === 1 &&
          found[0]?.queue_name === name &&
          /^[a-f0-9]{32}$/.test(found[0].queue_id),
        "production queue missing or ambiguous",
      );
      const queueId = found[0].queue_id;
      requireThat(
        !receipt.queues.some((q) => q.queueId === queueId),
        "production queues must be distinct",
      );
      const ids = owned(await api(`/queues/${queueId}/consumers`), name);
      receipt.queues.push({ name, queueId, consumerIds: ids });
    }
    for (const queue of receipt.queues) {
      // Re-read just before DELETE: refuse changed IDs/owners, including a new
      // subscription on a queue whose initial inventory was empty. The CF API
      // has no conditional DELETE; serialized release ownership remains needed.
      const ids = owned(
        await api(`/queues/${queue.queueId}/consumers`),
        queue.name,
      );
      requireThat(
        JSON.stringify(ids) === JSON.stringify(queue.consumerIds),
        "consumer inventory changed during detach",
      );
      for (const consumerId of ids) {
        const identity = { queueId: queue.queueId, consumerId };
        receipt.deleteAttempts.push(identity);
        await api(`/queues/${queue.queueId}/consumers/${consumerId}`, "DELETE");
        receipt.removed.push(identity);
      }
    }
    for (const queue of receipt.queues)
      requireThat(
        owned(await api(`/queues/${queue.queueId}/consumers`), queue.name)
          .length === 0,
        "consumer detach not confirmed",
      );
    receipt.status = "passed";
    receipt.consumersAbsent = true;
    receipt.observedAt = new Date().toISOString();
    return receipt;
  } catch (error) {
    receipt.status = "failed";
    receipt.observedAt = new Date().toISOString();
    // Keep attempted-but-unconfirmed IDs for operator follow-up. Never infer
    // deletion from a timeout or replay a DELETE without fresh ownership reads.
    throw Object.assign(
      new Error("production consumer detach failed", { cause: error }),
      { receipt },
    );
  }
}
async function main(args) {
  const [command, path, sha, image, mode, receiptOrOutput] = args;
  if (command === "template" && args.length === 1)
    return console.log(JSON.stringify(template(), null, 2));
  const m = validateManifest(JSON.parse(readFileSync(path, "utf8")));
  if (command === "disable-consumers" && args.length === 3) {
    const output = args[2];
    writeFileSync(
      output,
      JSON.stringify({
        format: "ghfind-feed-production-consumers-off-v1",
        status: "incomplete",
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    try {
      const result = await disableConsumers(m);
      writeFileSync(output, JSON.stringify(result, null, 2) + "\n", {
        mode: 0o600,
      });
      return console.log(
        "Owned production consumers detached and absence verified; queues and messages retained",
      );
    } catch (error) {
      writeFileSync(
        output,
        JSON.stringify(
          error.receipt ?? {
            format: "ghfind-feed-production-consumers-off-v1",
            status: "failed",
            requests: 0,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      throw error;
    }
  }
  if (command === "validate" && args.length === 2)
    return console.log(
      "Pinned production manifest and budget evidence validated",
    );
  if (
    command === "render" &&
    ((mode === "off" && args.length === 5) ||
      (mode === "baseline" && args.length === 6))
  ) {
    const receipt = receiptOrOutput
      ? JSON.parse(readFileSync(receiptOrOutput, "utf8"))
      : undefined;
    const runtime = renderRuntime(m, image, sha, mode, receipt);
    const adapter = renderAdapter(m, sha);
    writeFileSync(runtimeConfigPath, JSON.stringify(runtime, null, 2) + "\n");
    writeFileSync(adapterConfigPath, JSON.stringify(adapter, null, 2) + "\n");
    return console.log(
      `Rendered production ${mode} config; no resource or traffic mutation executed`,
    );
  }
  if (command === "verify" && args.length === 6) {
    const { verifyDeployment } = await import(
      "./feed-platform-production-readback.mjs"
    );
    const result = await verifyDeployment(m, sha, image, mode, {
      secret: process.env.FEED_RUNTIME_ADMIN_SECRET,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    writeFileSync(receiptOrOutput, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
    });
    return console.log(
      "Production immutable deployment and authenticated readiness verified; no OAuth, load or cost acceptance claimed",
    );
  }
  throw new Error(
    "usage: feed-platform-production.mjs template | validate MANIFEST | disable-consumers MANIFEST RECEIPT | render MANIFEST SHA IMAGE off | render MANIFEST SHA IMAGE baseline OFF_RECEIPT | verify MANIFEST SHA IMAGE off|baseline OUTPUT",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
