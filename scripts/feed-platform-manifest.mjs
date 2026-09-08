#!/usr/bin/env node
// Offline by design: this program never creates, changes, or deletes resources.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ACCOUNT = "8f19bebe359e4ec1a24c68c5f49c1584";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = new Set([
  "60d45096-bfe7-4de1-8b85-c1b66a466b0d",
  "9c4ac13a-4c90-40a8-9d56-d7141f864bbf",
  "bd305af9-2cab-4fe8-8c2f-324391cf105e",
]);
const names = {
  runtimeWorker: "ghfind-feed-runtime-staging",
  adapterWorker: "ghfind-feed-adapter-staging",
  coreDatabase: "ghfind-feed-staging-core",
  feedDatabase: "ghfind-feed-staging-db",
  archiveBucket: "ghfind-feed-staging-archive",
  queue: "ghfind-feed-staging-jobs",
  deadLetterQueue: "ghfind-feed-staging-dlq",
  terminalParkingQueue: "ghfind-feed-staging-terminal-parking",
};
export const secretNames = [
  "FEED_GATEWAY_SECRET",
  "FEED_SIGNING_SECRET",
  "FEED_BRIDGE_SECRET",
  "FEED_RUNTIME_ADMIN_SECRET",
  "FEED_EXECUTOR_SECRET",
  "FEED_SOURCE_SECRET",
  "FEED_DELIVERY_SECRET",
];
export const adapterSecretNames = [
  "FEED_BRIDGE_SECRET",
  "FEED_SOURCE_SECRET",
  "FEED_EXECUTOR_SECRET",
  "FEED_OPERATOR_SECRET",
  "FEED_DELIVERY_SECRET",
];
export const allSecretNames = [
  ...new Set([...secretNames, ...adapterSecretNames]),
];
export function template() {
  return {
    schemaVersion: 1,
    environment: "staging",
    accountId: ACCOUNT,
    ...names,
    coreDatabase: { name: names.coreDatabase, id: null },
    feedDatabase: { name: names.feedDatabase, id: null },
    billing: {
      confirmed: false,
      evidence: null,
      maximumMonthlyUSD: 100,
      projectedMonthlyUSD: null,
    },
    isolation: { reviewed: false, evidence: null },
    executorImplemented: false,
  };
}
function requireThat(value, label) {
  if (!value) throw new Error(label);
}
function evidence(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}
function exactKeys(value, allowed, label) {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === allowed.length &&
      Object.keys(value).every((key) => allowed.includes(key)),
    `unexpected ${label} fields`,
  );
}
export function validateManifest(m) {
  exactKeys(
    m,
    [
      "schemaVersion",
      "environment",
      "accountId",
      "runtimeWorker",
      "adapterWorker",
      "coreDatabase",
      "feedDatabase",
      "archiveBucket",
      "queue",
      "deadLetterQueue",
      "terminalParkingQueue",
      "billing",
      "isolation",
      "executorImplemented",
    ],
    "manifest",
  );
  exactKeys(
    m.billing,
    ["confirmed", "evidence", "maximumMonthlyUSD", "projectedMonthlyUSD"],
    "billing",
  );
  exactKeys(m.isolation, ["reviewed", "evidence"], "isolation");
  for (const key of ["coreDatabase", "feedDatabase"])
    exactKeys(m[key], ["name", "id"], key);
  requireThat(
    m?.schemaVersion === 1 &&
      m.environment === "staging" &&
      m.accountId === ACCOUNT,
    "unexpected account/environment/manifest version",
  );
  for (const key of [
    "runtimeWorker",
    "adapterWorker",
    "archiveBucket",
    "queue",
    "deadLetterQueue",
    "terminalParkingQueue",
  ])
    requireThat(m[key] === names[key], `unexpected ${key}`);
  for (const key of ["coreDatabase", "feedDatabase"]) {
    requireThat(m[key]?.name === names[key], `unexpected ${key} name`);
    requireThat(
      typeof m[key].id === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          m[key].id,
        ) &&
        !forbidden.has(m[key].id) &&
        !/^0{8}-/.test(m[key].id),
      `missing or unsafe ${key} ID`,
    );
  }
  requireThat(
    m.coreDatabase.id !== m.feedDatabase.id,
    "staging databases must be distinct",
  );
  requireThat(
    m.billing?.confirmed === true &&
      evidence(m.billing.evidence) &&
      m.billing.maximumMonthlyUSD === 100 &&
      typeof m.billing.projectedMonthlyUSD === "number" &&
      m.billing.projectedMonthlyUSD > 0 &&
      m.billing.projectedMonthlyUSD <= 80,
    "billing evidence or budget gate missing",
  );
  requireThat(
    m.isolation?.reviewed === true && evidence(m.isolation.evidence),
    "isolation review evidence missing",
  );
  requireThat(
    m.executorImplemented === true,
    "durable executor is not implemented",
  );
  return m;
}
export function validateImage(image) {
  requireThat(
    typeof image === "string" &&
      new RegExp(
        `^registry\\.cloudflare\\.com/${ACCOUNT}/ghfind-feed@sha256:[a-f0-9]{64}$`,
      ).test(image) &&
      !/@sha256:0{64}$/.test(image),
    "immutable image digest required",
  );
}
export function renderRuntime(m, image, sha) {
  validateManifest(m);
  validateImage(image);
  requireThat(/^[a-f0-9]{40}$/.test(sha), "exact release SHA required");
  const config = JSON.parse(
    readFileSync(resolve(root, "platform/runtime/wrangler.jsonc"), "utf8"),
  );
  config.name = m.runtimeWorker;
  config.workers_dev = true;
  config.vars = {
    ...config.vars,
    FEED_ENVIRONMENT: "staging",
    FEED_RELEASE_SHA: sha,
    FEED_IMAGE_REFERENCE: image,
    FEED_EXECUTOR_ENABLED: "true",
    FEED_SOURCE_RELAY_ENABLED: "true",
    FEED_QUEUE_NAME: m.queue,
    FEED_DLQ_NAME: m.deadLetterQueue,
  };
  config.services = [{ binding: "FEED_ADAPTER", service: m.adapterWorker }];
  config.containers = config.containers.map((c) => ({
    ...c,
    name: `${m.runtimeWorker}-${c.class_name.toLowerCase()}`,
    image,
  }));
  config.triggers = { crons: ["* * * * *"] };
  config.queues = {
    producers: [{ binding: "FEED_JOBS_QUEUE", queue: m.queue }],
    consumers: [
      {
        queue: m.queue,
        max_batch_size: 1,
        max_batch_timeout: 5,
        max_retries: 5,
        max_concurrency: 1,
        dead_letter_queue: m.deadLetterQueue,
      },
      {
        queue: m.deadLetterQueue,
        max_batch_size: 1,
        max_batch_timeout: 5,
        max_retries: 5,
        max_concurrency: 1,
        dead_letter_queue: m.terminalParkingQueue,
      },
    ],
  };
  return config;
}
export function resourcePlan() {
  return {
    mode: "dry-run",
    accountId: ACCOUNT,
    resources: template(),
    secretNames: allSecretNames,
    runtimeSecretNames: secretNames,
    adapterSecretNames,
    instructions:
      "These are argument arrays for the release owner; no commands were executed. Use account-pinned reviewed Actions provision workflow. Read existing named resources before creation; do not reuse production IDs.",
    commands: [
      ["wrangler", "d1", "create", names.coreDatabase],
      ["wrangler", "d1", "create", names.feedDatabase],
      ["wrangler", "r2", "bucket", "create", names.archiveBucket],
      ["wrangler", "queues", "create", names.deadLetterQueue],
      ["wrangler", "queues", "create", names.queue],
    ],
    supplementalResource: {
      name: names.terminalParkingQueue,
      messageRetentionSeconds: 1209600,
      automaticConsumer: false,
      evidence:
        "Separate serial creation/readback receipt; original five-resource provision hash remains unchanged",
    },
    requiredGitHubEnvironment: "Feed staging",
    cloudflareActionsSecret: "CF_FEED_STAGING_API_TOKEN",
  };
}
export function renderAdapter(m) {
  validateManifest(m);
  const config = JSON.parse(
    readFileSync(resolve(root, "platform/feed/wrangler.jsonc"), "utf8"),
  );
  requireThat(
    adapterSecretNames.every((name) =>
      config.secrets?.required?.includes(name),
    ),
    "source, bridge, cleanup and delivery adapter secret contracts must be implemented",
  );
  config.name = m.adapterWorker;
  config.account_id = ACCOUNT;
  config.workers_dev = false;
  config.preview_urls = false;
  config.d1_databases = [
    {
      binding: "FEED_DB",
      database_name: m.feedDatabase.name,
      database_id: m.feedDatabase.id,
      migrations_dir: "../../migrations-feed",
    },
    {
      binding: "CORE_DB",
      database_name: m.coreDatabase.name,
      database_id: m.coreDatabase.id,
      migrations_dir: "../../migrations",
    },
  ];
  config.vars = { ...config.vars, FEED_SEMANTIC_STATE: "disabled" };
  config.r2_buckets = [
    { binding: "FEED_ARCHIVE", bucket_name: m.archiveBucket },
  ];
  return config;
}
function main(args) {
  const [command = "plan", path, image, sha, output] = args;
  if (command === "plan")
    return console.log(JSON.stringify(resourcePlan(), null, 2));
  if (!path) throw new Error("manifest path required");
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (command === "render-adapter") {
    requireThat(
      image &&
        resolve(image) ===
          resolve(root, "platform/feed/wrangler.staging.generated.json"),
      "output must be the adapter staging config",
    );
    writeFileSync(image, JSON.stringify(renderAdapter(m), null, 2) + "\n");
    return console.log("Rendered isolated adapter configuration");
  }
  if (command === "validate") {
    validateManifest(m);
    return console.log("Manifest isolation, billing and executor gates passed");
  }
  if (command === "render") {
    requireThat(
      output &&
        resolve(output) ===
          resolve(root, "platform/runtime/wrangler.staging.generated.json"),
      "output must be the ignored runtime staging config",
    );
    writeFileSync(
      output,
      JSON.stringify(renderRuntime(m, image, sha), null, 2) + "\n",
    );
    return console.log("Rendered isolated staging configuration");
  }
  throw new Error(
    "usage: feed-platform-manifest.mjs [plan | validate manifest.json | render manifest.json image@digest SHA platform/runtime/wrangler.staging.generated.json]",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
