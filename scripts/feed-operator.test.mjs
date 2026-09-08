import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { template, ACCOUNT } from "./feed-platform-manifest.mjs";
import {
  executeOperator,
  validateCommand,
  runCommandId,
  statusEvidence,
} from "./feed-operator.mjs";
const sha = "a".repeat(40),
  image = `registry.cloudflare.com/${ACCOUNT}/ghfind-feed@sha256:${"b".repeat(64)}`,
  workerVersionId = "12345678-1234-4234-8234-123456789012";
function scenario() {
  const manifest = template();
  manifest.coreDatabase.id = "12345678-1234-1234-1234-123456789012";
  manifest.feedDatabase.id = "22345678-1234-1234-1234-123456789012";
  manifest.billing = {
    confirmed: true,
    evidence: "https://example.com/qualified",
    maximumMonthlyUSD: 100,
    projectedMonthlyUSD: 79,
  };
  manifest.isolation = {
    reviewed: true,
    evidence: "https://example.com/isolation",
  };
  manifest.executorImplemented = true;
  const release = {
    releaseSHA: sha,
    workerVersionId,
    verifiedAt: "2026-09-08T01:00:00Z",
    applications: ["feedapi", "feedexecutor"].map((s) => ({
      name: `${manifest.runtimeWorker}-${s}`,
      image,
    })),
  };
  const runtime = {
    bindings: [
      {
        name: "FEED_ADAPTER",
        type: "service",
        service: manifest.adapterWorker,
      },
      ...Object.entries({
        FEED_ENVIRONMENT: "staging",
        FEED_RELEASE_SHA: sha,
        FEED_WRITER_EPOCH: "1",
      }).map(([name, text]) => ({ name, type: "plain_text", text })),
    ],
  };
  const adapter = {
    bindings: [
      { name: "FEED_DB", type: "d1", id: manifest.feedDatabase.id },
      { name: "CORE_DB", type: "d1", id: manifest.coreDatabase.id },
      {
        name: "FEED_ARCHIVE",
        type: "r2_bucket",
        bucket_name: manifest.archiveBucket,
      },
    ],
  };
  const calls = [];
  let mutations = 0;
  let failReplay = false;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    assert.equal(init.redirect, "error");
    if (url.includes("api.cloudflare.com")) {
      assert.equal(init.method, "GET");
      assert.equal(init.headers.authorization, "Bearer metadata-token");
      const result = path.endsWith("/subdomain")
        ? { subdomain: "fixture" }
        : path.includes(manifest.runtimeWorker)
          ? runtime
          : adapter;
      return Response.json({ success: true, result });
    }
    if (path === "/healthz") {
      assert.equal(init.headers, undefined);
      return Response.json({
        healthy: true,
        version: sha,
        workerVersionId,
        contractVersion: "1",
      });
    }
    assert.equal(init.headers.authorization, `Bearer ${"o".repeat(32)}`);
    assert.equal(init.headers["x-feed-operator"], "p".repeat(32));
    if (path.endsWith("/replay")) {
      mutations++;
      if (failReplay) throw new Error("uncertain response");
      return Response.json({ ok: true });
    }
    assert.equal(path, "/internal/runtime/feed-admin/v1/status");
    return Response.json({
      job: {
        id: "event:1",
        status: mutations ? "pending" : "dead_letter",
        attempts: 6,
        lastError: "source_unavailable",
      },
      delivery: null,
      terminalEvidence: null,
    });
  };
  const command = {
    action: "replay",
    target: "staging",
    kind: "sourceEvent",
    id: "event:1",
    operator: "octocat",
    reason: "Source outage resolved; retry this event",
    commandId: workerVersionId,
  };
  return {
    options: {
      command,
      manifest,
      release,
      sha,
      runtimeURL: `https://${manifest.runtimeWorker}.fixture.workers.dev`,
      apiToken: "metadata-token",
      opsSecret: "o".repeat(32),
      operatorSecret: "p".repeat(32),
      fetcher,
    },
    runtime,
    adapter,
    calls,
    get mutations() {
      return mutations;
    },
    fail() {
      failReplay = true;
    },
  };
}
test("default operator command is offline and production is not enrolled", () => {
  const data = JSON.parse(
    execFileSync(process.execPath, ["scripts/feed-operator.mjs"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    }),
  );
  assert.equal(data.productionEnabled, false);
  assert.equal(data.limits.replayWrites, 1);
  const f = scenario();
  assert.throws(
    () => validateCommand({ ...f.options.command, target: "production" }),
    /not_enrolled/,
  );
});
test("one replay verifies account, bindings and release before sending privileged headers", async () => {
  const f = scenario();
  const result = await executeOperator(f.options);
  assert.equal(f.calls.length, 7);
  assert.equal(f.mutations, 1);
  assert.equal(result.commandState, "accepted");
  assert.equal(result.executionState, "incomplete");
  assert.equal(result.after.job.status, "pending");
  assert.equal(Object.hasOwn(result, "reason"), false);
  assert.equal(JSON.stringify(result).includes("metadata-token"), false);
});
test("wrong origin, database, active version or target fail before any replay", async () => {
  for (const kind of ["origin", "database", "release", "production"]) {
    const f = scenario();
    if (kind === "origin")
      f.options.runtimeURL =
        "https://ghfind-feed-runtime-staging.foreign.workers.dev";
    if (kind === "database")
      f.adapter.bindings[0].id = "60d45096-bfe7-4de1-8b85-c1b66a466b0d";
    if (kind === "release")
      f.options.release.workerVersionId =
        "22345678-1234-4234-8234-123456789012";
    if (kind === "production") f.options.command.target = "production";
    await assert.rejects(executeOperator(f.options));
    assert.equal(f.mutations, 0);
  }
});
test("uncertain mutation is not retried and evidence keeps the same command ID", async () => {
  const f = scenario();
  f.fail();
  const result = await executeOperator(f.options);
  assert.equal(f.mutations, 1);
  assert.equal(result.commandState, "uncertain");
  assert.equal(result.commandId, f.options.command.commandId);
  assert.equal(result.executionState, "incomplete");
});
test("a status action does no writes and returns only whitelisted operational metadata", async () => {
  const f = scenario();
  f.options.command = {
    action: "status",
    target: "staging",
    kind: "sourceEvent",
    id: "event:1",
  };
  const result = await executeOperator(f.options);
  assert.equal(f.mutations, 0);
  assert.equal(f.calls.length, 5);
  assert.equal(result.commandState, "not_requested");
  const data = statusEvidence(
    {
      job: {
        id: "event:1",
        status: "failed",
        rawAssessment: "private",
        lastError: "private user text",
      },
      delivery: {
        deliveryId: "source:1",
        status: "terminal",
        payload: "private",
      },
      terminalEvidence: {
        deliveryId: "source:1",
        messageId: "m1",
        queue: "dlq",
        attempts: 6,
        receivedAt: 100,
        isCurrent: false,
      },
    },
    "event:1",
  );
  assert.equal(JSON.stringify(data).includes("private"), false);
  assert.equal(data.terminalEvidence.isCurrent, false);
  assert.equal(data.job.lastError, "redacted_error_code");
});
test("command UUID is stable across reruns and distinct across jobs and invalid bodies reject", () => {
  assert.equal(
    runCommandId("hikariming/ghfind", "123", "deletion", "del:1"),
    runCommandId("hikariming/ghfind", "123", "deletion", "del:1"),
  );
  assert.notEqual(
    runCommandId("hikariming/ghfind", "123", "deletion", "del:1"),
    runCommandId("hikariming/ghfind", "124", "deletion", "del:1"),
  );
  const f = scenario();
  for (const command of [
    { ...f.options.command, url: "https://other" },
    { ...f.options.command, reason: "short" },
    { ...f.options.command, commandId: "bad" },
    { ...f.options.command, id: "*" },
  ])
    assert.throws(() => validateCommand(command));
});
