import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  ACCOUNT,
  template,
  validateManifest,
  validateImage,
  renderRuntime,
  resourcePlan,
  secretNames,
  adapterSecretNames,
  allSecretNames,
} from "./feed-platform-manifest.mjs";
const image = `registry.cloudflare.com/${ACCOUNT}/ghfind-feed@sha256:${"a".repeat(64)}`;
const sha = "b".repeat(40);
function manifest() {
  const m = template();
  m.coreDatabase.id = "12345678-1234-1234-1234-123456789012";
  m.feedDatabase.id = "22345678-1234-1234-1234-123456789012";
  m.billing = {
    confirmed: true,
    evidence: "https://example.com/billing-evidence",
    maximumMonthlyUSD: 100,
    projectedMonthlyUSD: 79,
  };
  m.isolation = {
    reviewed: true,
    evidence: "https://example.com/isolation-evidence",
  };
  m.executorImplemented = true;
  return m;
}
test("unconfigured example fails closed and dry-run never executes actions", () => {
  assert.throws(() => validateManifest(template()));
  const plan = resourcePlan();
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.commands.length, 5);
  const output = JSON.parse(
    execFileSync(process.execPath, ["scripts/feed-platform-manifest.mjs"], {
      encoding: "utf8",
    }),
  );
  assert.equal(output.mode, "dry-run");
  assert.equal(output.resources.coreDatabase.id, null);
});
test("every known live/development database and shared database is rejected", () => {
  for (const id of [
    "60d45096-bfe7-4de1-8b85-c1b66a466b0d",
    "9c4ac13a-4c90-40a8-9d56-d7141f864bbf",
    "bd305af9-2cab-4fe8-8c2f-324391cf105e",
  ]) {
    const m = manifest();
    m.coreDatabase.id = id;
    assert.throws(() => validateManifest(m), /unsafe/);
  }
  const m = manifest();
  m.coreDatabase.id = m.feedDatabase.id;
  assert.throws(() => validateManifest(m), /distinct/);
});
test("missing receipts, over-budget numbers, arbitrary secrets and endpoint credentials reject", () => {
  for (const change of [
    (m) => (m.billing.confirmed = false),
    (m) => (m.billing.projectedMonthlyUSD = 81),
    (m) => (m.billing.evidence = null),
    (m) => (m.billing.evidence = "https://user:password@example.com"),
    (m) => (m.billing.evidence = "https://example.com?token=secret"),
    (m) => (m.isolation.reviewed = false),
    (m) => (m.executorImplemented = false),
    (m) => (m.secret = "unintended-secret"),
    (m) => (m.runtimeWorker = "ghfind"),
    (m) => (m.accountId = "other-account"),
  ]) {
    const m = manifest();
    change(m);
    assert.throws(() => validateManifest(m));
  }
});
test("mutable, foreign and all-zero images reject", () => {
  for (const value of [
    "Dockerfile.feed",
    `registry.cloudflare.com/${ACCOUNT}/ghfind-feed:latest`,
    image.replace(ACCOUNT, "foreign"),
    image.replace(/a{64}$/, "0".repeat(64)),
  ])
    assert.throws(() => validateImage(value));
});
test("render preserves instance caps, private adapter and exact pre-pushed image identity", () => {
  const m = manifest();
  const c = renderRuntime(m, image, sha);
  assert.equal(c.account_id, ACCOUNT);
  assert.equal(c.name, m.runtimeWorker);
  assert.equal(c.vars.FEED_RELEASE_SHA, sha);
  assert.equal(c.vars.FEED_MODE, "off");
  assert.equal(c.vars.FEED_EXECUTOR_ENABLED, "true");
  assert.deepEqual(
    c.containers.map((v) => [
      v.class_name,
      v.instance_type,
      v.max_instances,
      v.image,
    ]),
    [
      ["FeedAPI", "basic", 2, image],
      ["FeedExecutor", "basic", 1, image],
    ],
  );
  assert.deepEqual(c.services, [
    { binding: "FEED_ADAPTER", service: m.adapterWorker },
  ]);
  assert.equal(c.vars.FEED_SOURCE_RELAY_ENABLED, "true");
  assert.deepEqual(c.triggers.crons, ["* * * * *"]);
  assert.deepEqual(c.queues.producers, [
    { binding: "FEED_JOBS_QUEUE", queue: m.queue },
  ]);
  assert.equal(c.queues.consumers[0].max_concurrency, 1);
  assert.equal(c.queues.consumers[0].max_batch_size, 1);
  assert.equal(c.queues.consumers[0].max_retries, 5);
  assert.equal(c.queues.consumers[0].dead_letter_queue, m.deadLetterQueue);
  assert.equal(c.queues.consumers.length, 2);
  assert.equal(c.queues.consumers[1].queue, m.deadLetterQueue);
  assert.equal(c.queues.consumers[1].max_retries, 5);
  assert.equal(c.queues.consumers[1].dead_letter_queue, m.terminalParkingQueue);
  assert.equal(
    c.queues.consumers.some((v) => v.queue === m.terminalParkingQueue),
    false,
  );
});

test("operator credential stays adapter-only while all staging credentials remain distinct", () => {
  assert.equal(secretNames.includes("FEED_OPERATOR_SECRET"), false);
  assert.equal(adapterSecretNames.includes("FEED_OPERATOR_SECRET"), true);
  assert.equal(adapterSecretNames.includes("FEED_EXECUTOR_SECRET"), true);
  assert.equal(allSecretNames.length, 8);
  assert.equal(secretNames.includes("FEED_DELIVERY_SECRET"), true);
  assert.equal(adapterSecretNames.includes("FEED_DELIVERY_SECRET"), true);
  assert.equal(new Set(allSecretNames).size, allSecretNames.length);
});
