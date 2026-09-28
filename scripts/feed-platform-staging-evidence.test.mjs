import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./feed-platform-web.test.mjs";
import { renderWeb } from "./feed-platform-web.mjs";
import { ACCOUNT } from "./feed-platform-manifest.mjs";
import { createEvidence, verifyEvidence, milestones, hash } from "./feed-platform-staging-evidence.mjs";

const now = Date.parse("2026-09-09T12:00:00Z"), stamp = seconds => new Date(now - seconds * 1000).toISOString();
function inputs() {
  const manifest = fixture(), sha = "a".repeat(40), tree = "b".repeat(40);
  const context = { repository: "hikariming/ghfind", runId: "12345", runAttempt: "2", sourceSha: sha, sourceTree: tree };
  const profile = () => ({ status: "passed", milestones: Object.fromEntries(milestones.map(k => [k, true])) });
  const worker = "12345678-1234-4234-8234-123456789012", webVersion = "22345678-1234-4234-8234-123456789012";
  const image = `registry.cloudflare.com/${ACCOUNT}/ghfind-feed@sha256:${"c".repeat(64)}`;
  const files = [{ path: "worker.js", bytes: 20, sha256: "d".repeat(64) }, { path: "assets/index.html", bytes: 20, sha256: "e".repeat(64) }];
  const input = {
    manifest,
    ci: { version: "ghfind.feed-ci.v1", kind: "release", eligible: true, createdAt: stamp(1000),
      context: { repository: context.repository, event: "push", branch: "codex/feed-fixture", sourceSha: sha, checkoutSha: sha, treeSha: tree, runId: "10000", runAttempt: "1" },
      jobs: Object.fromEntries(["verify", "feed-contracts", "feed-runtime", "feed-e2e"].map(name => [name, { name, result: "success", checkoutSha: sha, treeSha: tree }])),
      localE2E: { format: "ghfind-complete-local-e2e-v1", sourceSha: sha, sourceTree: tree, status: "passed", cleanupSuccessful: true, externalProviders: "local-fixture-transports", realOAuth: false,
        profiles: { cf_d1_r2: profile(), postgres: profile() } } },
    resources: { verified: true, accountId: ACCOUNT, environment: "staging", terminalParkingQueue: manifest.terminalParkingQueue, retentionSeconds: 1209600,
      queueIdentities: [manifest.queue, manifest.deadLetterQueue, manifest.terminalParkingQueue].map((name, i) => ({name, id: String(i+1).repeat(32)})), observedAt: stamp(950), webWorker: manifest.web.worker, webCacheBucket: manifest.web.cacheBucket, webOrigin: manifest.web.origin,
      coreDatabaseId: manifest.coreDatabase.id, feedDatabaseId: manifest.feedDatabase.id, archiveBucket: manifest.archiveBucket,
      runtimeWorker: manifest.runtimeWorker, adapterWorker: manifest.adapterWorker, queue: manifest.queue, deadLetterQueue: manifest.deadLetterQueue },
    webBuild: { format: "ghfind-feed-web-build-v1", status: "passed", sourceSha: sha, sourceTree: tree, origin: manifest.web.origin, startedAt: stamp(900), finishedAt: stamp(600),
      runtimeSecretsPresentDuringBuild: false, wranglerDryRunPassed: true, configSHA256: hash(renderWeb(manifest, sha)), inventory: { files, bytes: 40, sha256: hash(files) } },
    runtimeProbes: { schemaVersion: 1, kind: "bounded-runtime-probes", successful: true, releaseSHA: sha, workerVersionId: worker, configuredImage: image, startedAt: stamp(500), finishedAt: stamp(400),
      readiness: ["api-0", "api-1", "executor-0"].flatMap(target => Array.from({ length: 7 }, () => ({ target, ready: true, version: sha, contractVersion: "1", storageWriterVersion: 2,
        storeProfile: "cf_d1_r2", writerEpoch: 1, service: target === "executor-0" ? "feed-worker" : "feed-api" }))) },
    runtimeDeployment: { verifiedAt: stamp(350), workerVersionId: worker, releaseSHA: sha,
      applications: [["feedapi", ["api-0", "api-1"]], ["feedexecutor", ["executor-0"]]].map(([suffix, names]) => ({ applicationId: suffix, name: `${manifest.runtimeWorker}-${suffix}`, image, version: 2,
        instances: names.map(name => ({ id: name, name, state: "running", version: 2 })) })) },
    webDeployment: { format: "ghfind-feed-web-deployment-v1", status: "passed", sourceSha: sha, worker: manifest.web.worker, origin: manifest.web.origin,
      versionId: webVersion, deploymentId: worker, tag: `staging-${sha}`, scriptEtag: "etag", bindingIdentitySHA256: "f".repeat(64), bindingsVerified: true, oauthBeginVerified: true,
      anonymousFeedRejected: true, realOAuth: false, observedAt: stamp(10) },
    remoteJourney: { format: "ghfind-feed-e2e-remote-v1", status: "passed", sourceSha: sha, sourceTree: tree, realOAuth: true, externalProviders: "real", cleanupSuccessful: true,
      startedAt: stamp(300), finishedAt: stamp(20), profiles: { cf_d1_r2: profile() },
      identities: manifest.web.oauth.identities.map(i => ({ ...i, oauthBegin: true, oauthCallback: true })),
      deployment: { worker: manifest.web.worker, sourceSha: sha, workerVersionId: webVersion } },
  };
  return { input, context };
}
test("same-run exact source, immutable deployed versions and real journey produce a verifiable receipt", () => {
  const { input, context } = inputs(); const evidence = createEvidence(input, context, now);
  assert.equal(verifyEvidence(JSON.parse(JSON.stringify(evidence)), context, now + 10000), true);
  assert.equal(evidence.profiles.cf_d1_r2.milestones.deletionCompleted, true);
  assert.throws(() => verifyEvidence(evidence, { ...context, runAttempt: "3" }, now), /current checkout/);
  assert.throws(() => verifyEvidence(evidence, { ...context, sourceTree: "c".repeat(40) }, now), /current checkout/);
  assert.throws(() => verifyEvidence(evidence, context, now + 25 * 3600000), /stale/);
});
test("a CI green badge, one-profile local pass, basic OAuth redirect, queued deletion or stale container never satisfy the gate", () => {
  const changes = [
    i => { i.ci.context.event = "pull_request"; }, i => { i.ci.jobs["feed-e2e"].result = "skipped"; },
    i => { i.ci.jobs.verify.checkoutSha = "0".repeat(40); }, i => { delete i.ci.localE2E.profiles.postgres; },
    i => { i.ci.localE2E.cleanupSuccessful = false; }, i => { i.resources.webCacheBucket = "ghfind-next-cache"; },
    i => { i.webBuild.wranglerDryRunPassed = false; }, i => { i.webBuild.runtimeSecretsPresentDuringBuild = true; },
    i => { i.webBuild.inventory.files[0].sha256 = "0".repeat(64); }, i => { i.runtimeProbes.readiness[0].storageWriterVersion = 1; },
    i => { i.runtimeProbes.readiness.pop(); }, i => { i.runtimeDeployment.applications[1].instances[0].version = 1; },
    i => { i.runtimeDeployment.applications[0].image = i.runtimeProbes.configuredImage.replace(/c/g, "d"); },
    i => { i.remoteJourney.realOAuth = false; }, i => { i.remoteJourney.externalProviders = "local-fixture-transports"; },
    i => { i.remoteJourney.cleanupSuccessful = false; }, i => { i.remoteJourney.identities[1].githubId = i.remoteJourney.identities[0].githubId; },
    i => { i.remoteJourney.identities[0].oauthCallback = false; }, i => { i.remoteJourney.deployment.workerVersionId = "33333333-3333-4333-8333-333333333333"; },
    i => { i.webDeployment.observedAt = stamp(40); },
    ...milestones.map(key => i => { i.remoteJourney.profiles.cf_d1_r2.milestones[key] = false; }),
  ];
  for (const change of changes) { const { input, context } = inputs(); change(input); assert.throws(() => createEvidence(input, context, now)); }
});
test("public receipt strips provider logs and instance environment and rejects later injected fields", () => {
  const { input, context } = inputs();
  input.remoteJourney.cookies = "sensitive-fixture-cookie";
  input.remoteJourney.identities[0].storageState = "sensitive-fixture-cookie";
  input.runtimeDeployment.applications[0].instances[0].environment = { TOKEN: "sensitive-fixture-cookie" };
  input.runtimeProbes.readiness[0].rawHeaders = "sensitive-fixture-cookie";
  input.ci.context.token = "sensitive-fixture-cookie";
  const evidence = createEvidence(input, context, now);
  assert.equal(JSON.stringify(evidence).includes("sensitive-fixture-cookie"), false);
  evidence.inputs.remoteJourney.cookies = "unrecognized";
  assert.throws(() => verifyEvidence(evidence, context, now), /unrecognized/);
});
test("workflow keeps exact CI, image-first isolation and private browser state outside artifacts", () => {
  const workflow = readFileSync(new URL("../.github/workflows/feed-staging.yml", import.meta.url), "utf8");
  for (const text of ["workflow_call:", "evidence_artifact:", "evidence_sha256:", "verify-ci-remote", "feed-platform-web-build.mjs", "feed-e2e-remote.mjs", "feed-platform-staging-evidence.mjs create", "FEED_E2E_ORDINARY_STORAGE_STATE_FILE", "FEED_E2E_GOVERNANCE_STORAGE_STATE_FILE"]) assert.ok(workflow.includes(text), text);
  assert.ok(workflow.indexOf("verify-ci-remote") < workflow.indexOf("wrangler containers push"));
  assert.ok(workflow.indexOf("wrangler containers push") < workflow.indexOf("wrangler d1 migrations apply"));
  assert.ok(workflow.indexOf("wrangler d1 migrations apply") < workflow.indexOf("--config platform/runtime/wrangler.web.staging.generated.json --secrets-file"));
  assert.equal(/secrets:\s*inherit/.test(workflow), false);
  const upload = workflow.slice(workflow.indexOf("name: Preserve nonsecret"), workflow.indexOf("name: Remove temporary"));
  assert.equal(/storage-state|secrets\.json/.test(upload), false);
  assert.ok(workflow.includes('timeout-minutes: 60'));
  const protection = workflow.slice(workflow.indexOf("  protection:"), workflow.indexOf("  deploy:"));
  assert.ok(protection.includes("--verify-existing"), "actual remote protection must be verified");
  assert.equal(/^    environment:/m.test(protection), false, "preflight cannot create or enter an unverified environment");
  const deploy = workflow.slice(workflow.indexOf("  deploy:"));
  assert.ok(deploy.includes("needs: [protection]"), "deployment must wait for actual protection readback");
});
