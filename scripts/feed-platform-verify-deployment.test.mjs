import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fixture } from "./feed-platform-web.test.mjs";
import { ACCOUNT } from "./feed-platform-manifest.mjs";
import { verifyDeployment, validateReadiness, readbackLimits } from "./feed-platform-verify-deployment.mjs";

function harness() {
  const manifest = fixture(), sha = "a".repeat(40), version = "12345678-1234-4234-8234-123456789012";
  const apiId = "22345678-1234-4234-8234-123456789012", workerId = "32345678-1234-4234-8234-123456789012";
  const image = `registry.cloudflare.com/${ACCOUNT}/ghfind-feed@sha256:${"b".repeat(64)}`;
  const secret = "fixture-admin-key".padEnd(40, "s"), probes = { successful: true, configuredImage: image, workerVersionId: version, releaseSHA: sha };
  const data = { ready: true, service: "feed-runtime", version: sha, contractVersion: "1", workerVersionId: version, configuredImage: image,
    containers: ["api-0", "api-1", "executor-0"].map(target => ({ target, ready: true, version: sha, contractVersion: "1", storageWriterVersion: 2,
      storeProfile: "cf_d1_r2", writerEpoch: 1, service: target === "executor-0" ? "feed-worker" : "feed-api" })) };
  const f = { manifest, image, probes, secret, data, calls: 0, reads: [], lastReady: -Infinity, delayMs: 0, appsState: null, metadataAborted: false, initialRequestsAborted: 0 };
  f.fetcher = async (url, options) => {
    assert.equal(String(url), `${manifest.web.runtimeOrigin}/readyz`);
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, `Bearer ${secret}`);
    options.signal.throwIfAborted(); f.calls++; f.lastReady = performance.now();
    return Response.json(f.data);
  };
  f.metadata = async (args, { signal }) => {
    f.reads.push(args);
    if (f.reads.length === 1 && f.delayMs) {
      try { await sleep(f.delayMs, undefined, { signal }); }
      catch (error) { f.metadataAborted = true; throw error; }
    }
    signal.throwIfAborted();
    if (args[0] === "deployments") return { versions: [{ version_id: version, percentage: 100 }] };
    if (args[1] === "list") {
      f.appsState = performance.now() - f.lastReady < 10000 ? "active" : "ready";
      return [[apiId, "feedapi"], [workerId, "feedexecutor"]].map(([id, suffix]) => ({ id, name: `${manifest.runtimeWorker}-${suffix}`, image, version: 4, state: f.appsState }));
    }
    assert.equal(args[1], "instances");
    const names = args[2] === apiId ? ["api-0", "api-1"] : ["executor-0"];
    const state = performance.now() - f.lastReady < 10000 ? "running" : "inactive";
    return { result_info: { next_page_token: null }, instances: names.map(name => ({ id: name + "-id", name, state, version: 4, environment: { SECRET: "never-persist-fixture" } })) };
  };
  f.verify = options => verifyDeployment(manifest, image, probes, { secret, fetcher: f.fetcher, metadata: f.metadata, ...options });
  return f;
}
test("12-second metadata delay keeps the 10-second-idle executor ready without changing its policy", async () => {
  const f = harness(); f.delayMs = 12000;
  const value = await f.verify();
  assert.ok(value.keepWarm.durationMs >= 12000);
  assert.equal(f.appsState, "active");
  assert.ok(f.calls >= 6 && f.calls <= readbackLimits.readinessRequests);
  assert.equal(value.keepWarm.metadataReads, 5);
  assert.equal(f.reads.filter(args => args[0] === "deployments").length, 2);
  assert.equal(value.keepWarm.stopped, true);
  assert.equal(JSON.stringify(value).includes("never-persist-fixture"), false);
  assert.deepEqual(value.applications[1].instances[0], { id: "executor-0-id", name: "executor-0", state: "running", version: 4 });
  const calls = f.calls;
  await sleep(2700); // covers the production heartbeat interval after return
  assert.equal(f.calls, calls, "successful verifier must leave no heartbeat running");
});
test("wrong release, writer, profile, epoch, duplicate or incorrect target blocks before metadata", async () => {
  for (const change of [
    d => { d.workerVersionId = "42345678-1234-4234-8234-123456789012"; },
    d => { d.configuredImage = d.configuredImage.replace(/b/g, "c"); },
    d => { d.containers[0].version = "c".repeat(40); }, d => { d.containers[0].storageWriterVersion = 1; },
    d => { d.containers[0].storeProfile = "postgres"; }, d => { d.containers[0].writerEpoch = 2; },
    d => { d.containers[0].target = "api-1"; }, d => { d.containers[2].service = "feed-api"; },
    d => { d.containers.pop(); },
  ]) {
    const f = harness(); change(f.data);
    await assert.rejects(f.verify(), /differs/);
    assert.equal(f.reads.length, 0);
  }
});
test("heartbeat identity drift aborts the pending metadata read and leaves no timer", async () => {
  const f = harness(); f.delayMs = 10000;
  const initial = f.fetcher;
  f.fetcher = async (url, options) => {
    if (f.calls >= 1) f.data.containers[2].writerEpoch = 2;
    return initial(url, options);
  };
  await assert.rejects(f.verify({ limits: { intervalMs: 10 } }), /Container readiness differs: executor-0/);
  assert.equal(f.metadataAborted, true);
  const calls = f.calls; await sleep(40); assert.equal(f.calls, calls);
});
test("failure cancels an in-flight heartbeat and global deadline cancels metadata", async () => {
  const f = harness(), initial = f.fetcher;
  f.fetcher = async (url, options) => {
    if (f.calls >= 1) {
      f.calls++;
      try { await sleep(10000, undefined, { signal: options.signal }); }
      catch (error) { f.initialRequestsAborted++; throw error; }
    }
    return initial(url, options);
  };
  f.metadata = async (_args, { signal }) => { await sleep(30, undefined, { signal }); throw new Error("metadata fixture failure"); };
  await assert.rejects(f.verify({ limits: { intervalMs: 5 } }), /metadata fixture failure/);
  assert.equal(f.initialRequestsAborted, 1);
  const calls = f.calls; await sleep(30); assert.equal(f.calls, calls);
  const deadline = harness(); deadline.delayMs = 10000;
  await assert.rejects(deadline.verify({ limits: { durationMs: 35, intervalMs: 5 } }), /deadline exceeded/);
  assert.equal(deadline.metadataAborted, true);
});
test("budgets, final Worker version and actual instance identity remain fail closed", async () => {
  const limited = harness(); limited.delayMs = 10000;
  await assert.rejects(limited.verify({ limits: { readinessRequests: 2, intervalMs: 5 } }), /request budget/);
  assert.equal(limited.metadataAborted, true);
  await assert.rejects(harness().verify({ limits: { durationMs: readbackLimits.durationMs + 1 } }), /only be tightened/);
  for (const wrong of ["instance", "version", "pagination"]) {
    const f = harness(), metadata = f.metadata;
    f.metadata = async (args, options) => {
      const result = await metadata(args, options);
      if (wrong === "instance" && args[1] === "instances") result.instances[0].name = "unknown-target";
      if (wrong === "pagination" && args[1] === "instances") result.result_info.next_page_token = "more";
      if (wrong === "version" && f.reads.length === 5) result.versions[0].version_id = "42345678-1234-4234-8234-123456789012";
      return result;
    };
    await assert.rejects(f.verify(), /differs|population|Instance/);
  }
  const f = harness(); f.manifest.coreDatabase.id = "60d45096-bfe7-4de1-8b85-c1b66a466b0d";
  await assert.rejects(f.verify()); assert.equal(f.calls, 0);
  assert.deepEqual(validateReadiness(f.data, f.probes, f.image).map(row => row.target), ["api-0", "api-1", "executor-0"]);
});
