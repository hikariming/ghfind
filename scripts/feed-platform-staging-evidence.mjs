#!/usr/bin/env node
// Verifies same-run evidence. This is not a signature service and performs no
// deployment: trust comes from the reviewed workflow, exact CI, and artifact SHA.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { validateWebManifest, renderWeb, repository } from "./feed-platform-web.mjs";
import { validateImage, ACCOUNT } from "./feed-platform-manifest.mjs";

export const milestones = Object.freeze(["oauthCallback", "assessmentFinalization", "sourceOutbox", "executorProjection", "governance", "preferences", "events", "deletionCompleted"]);
const sha40 = /^[a-f0-9]{40}$/, sha256 = /^[a-f0-9]{64}$/, decimal = /^[1-9][0-9]*$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const format = "ghfind-feed-staging-evidence-v1";
function requireThat(value, message) { if (!value) throw new Error(message); }
function same(a, b, message) { requireThat(isDeepStrictEqual(a, b), message); }
function pick(value, fields) { return Object.fromEntries(fields.map(k => [k, value?.[k]])); }
export function hash(value) { return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function time(value, label, now) {
  requireThat(typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 60000 && now - Date.parse(value) <= 24 * 3600000, `missing/stale ${label}`);
  return Date.parse(value);
}
function period(value, label, now) { requireThat(time(value.finishedAt, label, now) >= time(value.startedAt, label, now), `inverted ${label}`); }
function passedProfile(profile, label) {
  requireThat(profile?.status === "passed" && milestones.every(k => profile.milestones?.[k] === true), `${label} incomplete`);
}
export function actionContext(env = process.env, root = repository) {
  requireThat(env.GITHUB_REPOSITORY === "hikariming/ghfind" && decimal.test(env.GITHUB_RUN_ID) && decimal.test(env.GITHUB_RUN_ATTEMPT), "trusted current Actions context required");
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 }).trim();
  requireThat(!git(["status", "--porcelain", "--untracked-files=normal"]), "clean evidence checkout required");
  return { repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    sourceSha: git(["rev-parse", "HEAD"]), sourceTree: git(["rev-parse", "HEAD^{tree}"]) };
}
export function validateInputs(input, context, now = Date.now()) {
  const { manifest: m, ci, resources, webBuild: build, runtimeProbes: probes,
    runtimeDeployment: runtime, webDeployment: web, remoteJourney: journey } = input;
  validateWebManifest(m);
  const sha = context.sourceSha, tree = context.sourceTree;
  requireThat(context.repository === "hikariming/ghfind" && sha40.test(sha) && sha40.test(tree) && decimal.test(context.runId) && decimal.test(context.runAttempt), "invalid source/run context");
  const c = ci?.context;
  requireThat(ci?.version === "ghfind.feed-ci.v1" && ci.kind === "release" && ci.eligible === true &&
    c?.repository === context.repository && c.event === "push" && c.sourceSha === sha && c.checkoutSha === sha && c.treeSha === tree &&
    decimal.test(c.runId) && decimal.test(c.runAttempt), "exact push CI receipt required");
  time(ci.createdAt, "CI receipt", now);
  for (const name of ["verify", "feed-contracts", "feed-runtime", "feed-e2e"]) {
    const job = ci.jobs?.[name];
    requireThat(job?.result === "success" && job.checkoutSha === sha && job.treeSha === tree, `CI job ${name} not verified`);
  }
  const local = ci.localE2E;
  requireThat(local?.format === "ghfind-complete-local-e2e-v1" && local.sourceSha === sha && local.sourceTree === tree && local.status === "passed" && local.cleanupSuccessful === true &&
    local.realOAuth === false && local.externalProviders === "local-fixture-transports", "complete local E2E evidence required");
  for (const profile of ["cf_d1_r2", "postgres"]) passedProfile(local.profiles?.[profile], `local ${profile}`);
  requireThat(resources?.verified === true && resources.accountId === ACCOUNT && resources.environment === "staging" &&
    resources.terminalParkingQueue === m.terminalParkingQueue && resources.retentionSeconds === 1209600, "resource readback absent");
  requireThat(resources.queueIdentities?.length === 3 && [m.queue, m.deadLetterQueue, m.terminalParkingQueue].every(name =>
    resources.queueIdentities.filter(q => q.name === name && /^[a-f0-9]{32}$/.test(q.id)).length === 1), "queue identities absent");
  for (const [field, expected] of Object.entries({ webWorker: m.web.worker, webCacheBucket: m.web.cacheBucket, webOrigin: m.web.origin,
    coreDatabaseId: m.coreDatabase.id, feedDatabaseId: m.feedDatabase.id, archiveBucket: m.archiveBucket,
    runtimeWorker: m.runtimeWorker, adapterWorker: m.adapterWorker, queue: m.queue, deadLetterQueue: m.deadLetterQueue })) requireThat(resources[field] === expected, `resource mismatch: ${field}`);
  time(resources.observedAt, "resources", now);
  requireThat(build?.format === "ghfind-feed-web-build-v1" && build.status === "passed" && build.sourceSha === sha && build.sourceTree === tree &&
    build.origin === m.web.origin && build.runtimeSecretsPresentDuringBuild === false && build.wranglerDryRunPassed === true &&
    build.configSHA256 === hash(renderWeb(m, sha)) && build.inventory?.sha256 === hash(build.inventory.files), "actual Web build evidence mismatch");
  requireThat(Array.isArray(build.inventory.files) && build.inventory.files.length <= 20000 && build.inventory.files.some(f => f.path === "worker.js" && sha256.test(f.sha256)) &&
    build.inventory.files.some(f => f.path.startsWith("assets/") && sha256.test(f.sha256)) && Number.isSafeInteger(build.inventory.bytes) && build.inventory.bytes > 0 && build.inventory.bytes <= 1024 ** 3, "Web build inventory invalid");
  period(build, "Web build", now);
  requireThat(probes?.schemaVersion === 1 && probes.kind === "bounded-runtime-probes" && probes.successful === true && probes.releaseSHA === sha && uuid.test(probes.workerVersionId), "runtime probes missing or wrong source");
  validateImage(probes.configuredImage); period(probes, "runtime probes", now);
  requireThat(Array.isArray(probes.readiness) && probes.readiness.length === 21, "actual Container readiness identities absent");
  for (const target of ["api-0", "api-1", "executor-0"]) {
    const rows = probes.readiness.filter(row => row.target === target);
    requireThat(rows.length === 7 && rows.every(row => row.ready === true && row.version === sha && row.contractVersion === "1" && row.storageWriterVersion === 2 &&
      row.storeProfile === "cf_d1_r2" && row.writerEpoch === 1 && row.service === (target === "executor-0" ? "feed-worker" : "feed-api")), `Container readiness mismatch: ${target}`);
  }
  requireThat(runtime?.releaseSHA === sha && runtime.workerVersionId === probes.workerVersionId && runtime.applications?.length === 2, "active runtime deployment mismatch");
  time(runtime.verifiedAt, "runtime deployment", now);
  for (const [suffix, names] of [["feedapi", ["api-0", "api-1"]], ["feedexecutor", ["executor-0"]]]) {
    const apps = runtime.applications.filter(a => a.name === `${m.runtimeWorker}-${suffix}`);
    requireThat(apps.length === 1 && typeof apps[0].applicationId === "string" && apps[0].applicationId && apps[0].image === probes.configuredImage && apps[0].version != null, `immutable ${suffix} application missing`);
    const app = apps[0];
    requireThat(app.instances?.length === names.length, "Container population differs");
    for (const name of names) {
      const instances = app.instances.filter(i => i.name === name);
      requireThat(instances.length === 1 && instances[0].state === "running" && String(instances[0].version) === String(app.version), "running Container version differs");
    }
  }
  requireThat(web?.format === "ghfind-feed-web-deployment-v1" && web.status === "passed" && web.sourceSha === sha && web.worker === m.web.worker && web.origin === m.web.origin &&
    uuid.test(web.versionId) && uuid.test(web.deploymentId) && web.tag === `staging-${sha}` && web.scriptEtag && sha256.test(web.bindingIdentitySHA256) &&
    web.bindingsVerified === true && web.oauthBeginVerified === true && web.anonymousFeedRejected === true && web.realOAuth === false, "active Web readback mismatch");
  time(web.observedAt, "Web deployment", now);
  requireThat(journey?.format === "ghfind-feed-e2e-remote-v1" && journey.status === "passed" && journey.sourceSha === sha && journey.sourceTree === tree &&
    journey.realOAuth === true && journey.externalProviders === "real" && journey.cleanupSuccessful === true, "real external OAuth journey required");
  passedProfile(journey.profiles?.cf_d1_r2, "remote CF E2E"); period(journey, "remote journey", now);
  requireThat(Date.parse(journey.startedAt) >= Date.parse(build.finishedAt) && Date.parse(web.observedAt) >= Date.parse(journey.finishedAt), "final Web readback must follow real journey and build");
  same(journey.deployment, { worker: m.web.worker, sourceSha: sha, workerVersionId: web.versionId }, "journey ran against another Web version");
  requireThat(journey.identities?.length === 2, "both real identities required");
  for (const expected of m.web.oauth.identities) {
    const rows = journey.identities.filter(i => i.role === expected.role);
    requireThat(rows.length === 1 && rows[0].githubId === expected.githubId && rows[0].login === expected.login && rows[0].oauthBegin === true && rows[0].oauthCallback === true, `real identity mismatch: ${expected.role}`);
  }
  return true;
}
// Strip unrecognized fields (including remote logs, cookies, private instance
// environment, and provider payloads) before serializing the public artifact.
export function publicInputs(input) {
  const i = input;
  return {
    manifest: i.manifest,
    ci: { ...pick(i.ci, ["version", "kind", "createdAt", "eligible"]), context: pick(i.ci.context, ["repository", "event", "branch", "sourceSha", "checkoutSha", "treeSha", "runId", "runAttempt"]), jobs: Object.fromEntries(["verify", "feed-contracts", "feed-runtime", "feed-e2e"].map(name => [name, pick(i.ci.jobs?.[name], ["name", "result", "checkoutSha", "treeSha"])])),
      localE2E: { ...pick(i.ci.localE2E, ["format", "sourceSha", "sourceTree", "status", "cleanupSuccessful", "externalProviders", "realOAuth"]), profiles: profileSummary(i.ci.localE2E.profiles, ["cf_d1_r2", "postgres"]) } },
    resources: pick(i.resources, ["accountId", "environment", "terminalParkingQueue", "retentionSeconds", "queueIdentities", "verified", "observedAt", "webWorker", "webCacheBucket", "webOrigin", "coreDatabaseId", "feedDatabaseId", "archiveBucket", "runtimeWorker", "adapterWorker", "queue", "deadLetterQueue"]),
    webBuild: pick(i.webBuild, ["format", "status", "sourceSha", "sourceTree", "startedAt", "finishedAt", "origin", "runtimeSecretsPresentDuringBuild", "wranglerDryRunPassed", "configSHA256", "inventory"]),
    runtimeProbes: { ...pick(i.runtimeProbes, ["schemaVersion", "kind", "releaseSHA", "configuredImage", "workerVersionId", "successful", "startedAt", "finishedAt"]), readiness: i.runtimeProbes.readiness.map(row => pick(row, ["target", "ready", "version", "contractVersion", "storageWriterVersion", "storeProfile", "writerEpoch", "service"])) },
    runtimeDeployment: { ...pick(i.runtimeDeployment, ["verifiedAt", "workerVersionId", "releaseSHA"]), applications: i.runtimeDeployment.applications.map(app => ({ ...pick(app, ["applicationId", "name", "image", "version"]), instances: app.instances.map(instance => pick(instance, ["id", "name", "state", "version"])) })) },
    webDeployment: pick(i.webDeployment, ["format", "status", "observedAt", "sourceSha", "origin", "worker", "deploymentId", "versionId", "tag", "scriptEtag", "bindingIdentitySHA256", "bindingsVerified", "oauthBeginVerified", "anonymousFeedRejected", "realOAuth"]),
    remoteJourney: { ...pick(i.remoteJourney, ["format", "sourceSha", "sourceTree", "startedAt", "finishedAt", "status", "realOAuth", "externalProviders", "cleanupSuccessful", "deployment"]),
      profiles: profileSummary(i.remoteJourney.profiles, ["cf_d1_r2"]), identities: i.remoteJourney.identities.map(identity => pick(identity, ["role", "githubId", "login", "oauthBegin", "oauthCallback"])) },
  };
}
function profileSummary(profiles, names) { return Object.fromEntries(names.map(name => [name, { status: profiles[name].status, milestones: pick(profiles[name].milestones, milestones) }])); }
export function createEvidence(input, context, now = Date.now()) {
  validateInputs(input, context, now);
  const inputs = publicInputs(input);
  validateInputs(inputs, context, now);
  return { format, ...context, createdAt: new Date(now).toISOString(), ciRunId: inputs.ci.context.runId, ciRunAttempt: inputs.ci.context.runAttempt,
    status: "passed", realOAuth: true, externalProviders: "real", cleanupSuccessful: true,
    profiles: inputs.remoteJourney.profiles, inputs,
    boundaries: ["Isolated CF staging only", "No production cutover, sustained-load SLO, monthly availability or measured cost claim", "Local fixture transports are distinct from this real OAuth/provider gate"] };
}
export function verifyEvidence(value, context, now = Date.now()) {
  requireThat(value?.format === format, "unsupported staging receipt");
  same(pick(value, ["repository", "runId", "runAttempt", "sourceSha", "sourceTree"]), context, "receipt source/run/attempt differs from current checkout");
  time(value.createdAt, "staging receipt", now);
  const expected = createEvidence(value.inputs, context, Date.parse(value.createdAt));
  same(value, expected, "staging receipt derived fields or unrecognized content differs");
  validateInputs(value.inputs, context, now);
  return true;
}
function readJSON(path) { requireThat(statSync(path).isFile() && statSync(path).size <= 8 * 1024 * 1024, "bounded evidence file required"); return JSON.parse(readFileSync(path, "utf8")); }
function main(args) {
  const [command, ...rest] = args;
  const context = actionContext();
  if (command === "create" && rest.length === 9) {
    const keys = ["manifest", "ci", "resources", "webBuild", "runtimeProbes", "runtimeDeployment", "webDeployment", "remoteJourney"];
    const input = Object.fromEntries(keys.map((key, index) => [key, readJSON(rest[index])]));
    const result = createEvidence(input, context);
    writeFileSync(rest[8], JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(hash(readFileSync(rest[8]))); return;
  }
  if (command === "verify" && rest.length === 3) {
    const [path, sha, expectedHash] = rest;
    requireThat(sha === context.sourceSha && sha256.test(expectedHash), "exact source and artifact hash required");
    const value = readJSON(path);
    requireThat(hash(readFileSync(path)) === expectedHash, "staging artifact SHA256 differs");
    verifyEvidence(value, context); console.log("Current-run real CF staging evidence verified"); return;
  }
  throw new Error("usage: feed-platform-staging-evidence.mjs create MANIFEST CI RESOURCES BUILD PROBES RUNTIME WEB JOURNEY OUTPUT | verify RECEIPT SHA FILE_SHA256");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
