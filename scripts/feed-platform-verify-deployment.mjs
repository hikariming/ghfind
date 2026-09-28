#!/usr/bin/env node
// Control-plane reads are asynchronous so short-lived Containers can receive
// bounded readiness traffic during them. No sleep policy or resource is changed.
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateImage, ACCOUNT } from "./feed-platform-manifest.mjs";
import { validateWebManifest, repository } from "./feed-platform-web.mjs";
import { boundedJSON } from "./feed-platform-web-verify.mjs";

export const readbackLimits = Object.freeze({ durationMs: 120000, readinessRequests: 50, metadataReads: 5, intervalMs: 2500, requestMs: 5000, metadataMs: 30000 });
const targets = ["api-0", "api-1", "executor-0"];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function requireThat(value, message) { if (!value) throw new Error(message); }
export function validateReadiness(data, probes, image) {
  requireThat(data?.ready === true && data.service === "feed-runtime" && data.version === probes.releaseSHA && data.contractVersion === "1" &&
    data.workerVersionId === probes.workerVersionId && data.configuredImage === image, "Runtime readiness release identity differs");
  requireThat(data.containers?.length === targets.length, "Runtime readiness target population differs");
  return targets.map(target => {
    const rows = data.containers.filter(row => row.target === target), row = rows[0];
    requireThat(rows.length === 1 && row.ready === true && row.version === probes.releaseSHA && row.contractVersion === "1" &&
      row.storageWriterVersion === 2 && row.storeProfile === "cf_d1_r2" && String(row.writerEpoch) === "1" &&
      row.service === (target === "executor-0" ? "feed-worker" : "feed-api"), `Container readiness differs: ${target}`);
    return { target, ready: true, version: row.version, contractVersion: row.contractVersion, storageWriterVersion: row.storageWriterVersion,
      storeProfile: row.storeProfile, writerEpoch: 1, service: row.service };
  });
}
export async function runWrangler(args, { signal }) {
  // Never inherit the production root config or send the runtime admin role to
  // the metadata subprocess. AbortSignal terminates this owned child on failure.
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "CLOUDFLARE_API_TOKEN"].filter(k => typeof process.env[k] === "string").map(k => [k, process.env[k]]));
  const { stdout } = await promisify(execFile)(resolve(repository, "platform/runtime/node_modules/.bin/wrangler"),
    [...args, "--config", resolve(repository, "platform/runtime/wrangler.staging.generated.json")], {
      cwd: repository, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: readbackLimits.metadataMs, signal, killSignal: "SIGTERM",
      env: { ...env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CI: "true", WRANGLER_SEND_METRICS: "false" },
    });
  return JSON.parse(stdout);
}
export async function verifyDeployment(manifest, image, probes, { secret, fetcher = fetch, metadata = runWrangler, limits: narrower = {} } = {}) {
  const m = validateWebManifest(manifest);
  validateImage(image);
  requireThat(probes?.successful === true && probes.configuredImage === image && uuid.test(probes.workerVersionId) && /^[a-f0-9]{40}$/.test(probes.releaseSHA), "Passing matching probes required");
  requireThat(typeof secret === "string" && Buffer.byteLength(secret) >= 32 && !/[\x00-\x20\x7f]/.test(secret), "Dedicated runtime admin secret required");
  // Tests may tighten budgets; neither callers nor environment variables can
  // raise the production maximum or lengthen the interval past the idle bound.
  const limits = { ...readbackLimits, ...narrower };
  requireThat(Object.keys(limits).length === Object.keys(readbackLimits).length && Object.keys(readbackLimits).every(k => Number.isSafeInteger(limits[k]) && limits[k] > 0 && limits[k] <= readbackLimits[k]), "Readback limits may only be tightened");
  const started = performance.now(), run = new AbortController(), heartbeat = new AbortController();
  const deadline = setTimeout(() => run.abort(new Error("Deployment readback deadline exceeded")), limits.durationMs);
  let readinessRequests = 0, metadataReads = 0, lastReadiness, heartbeatFailure, loop;
  async function ready(signal = run.signal) {
    run.signal.throwIfAborted();
    requireThat(++readinessRequests <= limits.readinessRequests, "Readiness request budget exhausted");
    const response = await fetcher(new URL("/readyz", m.web.runtimeOrigin), {
      method: "GET", headers: { authorization: `Bearer ${secret}` }, redirect: "error",
      signal: AbortSignal.any([signal, run.signal, AbortSignal.timeout(limits.requestMs)]),
    });
    requireThat(response.ok, `Runtime readiness HTTP ${response.status}`);
    lastReadiness = validateReadiness(await boundedJSON(response, 16384), probes, image);
    run.signal.throwIfAborted();
  }
  async function read(args) {
    run.signal.throwIfAborted();
    requireThat(++metadataReads <= limits.metadataReads, "Metadata read budget exhausted");
    return metadata(args, { signal: AbortSignal.any([run.signal, AbortSignal.timeout(limits.metadataMs)]) });
  }
  function activeVersion(active) {
    requireThat(active.versions?.length === 1 && active.versions[0].percentage === 100 && active.versions[0].version_id === probes.workerVersionId,
      "Active Worker version differs from probe");
  }
  async function stopHeartbeat() {
    heartbeat.abort();
    await loop; // includes cancellation/join of an in-flight readiness request
  }
  try {
    await ready();
    loop = (async () => {
      try {
        while (!heartbeat.signal.aborted) {
          await sleep(limits.intervalMs, undefined, { signal: heartbeat.signal });
          await ready(heartbeat.signal);
        }
      } catch (error) {
        const stopped = heartbeat.signal.aborted && (error === heartbeat.signal.reason || error?.cause === heartbeat.signal.reason);
        if (!stopped) { heartbeatFailure = error; run.abort(error); }
      }
    })();
    activeVersion(await read(["deployments", "status", "--json"]));
    const apps = await read(["containers", "list", "--json"]);
    requireThat(Array.isArray(apps), "Container application inventory invalid");
    const applications = [];
    for (const [suffix, expectedNames] of [["feedapi", ["api-0", "api-1"]], ["feedexecutor", ["executor-0"]]]) {
      const matches = apps.filter(app => app.name === `${m.runtimeWorker}-${suffix}`);
      requireThat(matches.length === 1, `Container application missing or ambiguous: ${suffix}`);
      const app = matches[0];
      requireThat(uuid.test(app.id) && app.image === image && app.state === "active" && app.version != null, `Container image/state differs: ${suffix}`);
      const result = await read(["containers", "instances", app.id, "--per-page", "10", "--json"]);
      requireThat(!result.result_info?.next_page_token && result.instances?.length === expectedNames.length, `Unexpected instance population: ${suffix}`);
      for (const name of expectedNames) {
        const rows = result.instances.filter(instance => instance.name === name);
        requireThat(rows.length === 1 && typeof rows[0].id === "string" && rows[0].id && rows[0].state === "running" && String(rows[0].version) === String(app.version), `Instance has not reached published image version: ${name}`);
      }
      // Select nonsecret metadata only; never persist arbitrary CLI fields.
      applications.push({ applicationId: app.id, name: app.name, image: app.image, version: app.version,
        instances: result.instances.map(i => ({ id: i.id, name: i.name, state: i.state, version: i.version })) });
    }
    activeVersion(await read(["deployments", "status", "--json"]));
    await stopHeartbeat();
    if (heartbeatFailure) throw heartbeatFailure;
    await ready(); // no overlapping heartbeat; recheck SHA/profile/epoch after metadata
    return { verifiedAt: new Date().toISOString(), workerVersionId: probes.workerVersionId, releaseSHA: probes.releaseSHA, applications,
      keepWarm: { completed: true, stopped: true, runtimeOrigin: m.web.runtimeOrigin, durationMs: Math.round(performance.now() - started),
        readinessRequests, metadataReads, limits, lastReadiness,
        note: "Temporary readback readiness only; executor idle policy remains 10 seconds." } };
  } catch (error) {
    throw heartbeatFailure ?? (run.signal.aborted ? run.signal.reason : error);
  } finally {
    heartbeat.abort(); run.abort(); clearTimeout(deadline);
    await loop;
  }
}
async function main(args) {
  const [manifestPath, image, probePath, output, ...extra] = args;
  requireThat(manifestPath && image && probePath && output && extra.length === 0, "usage: feed-platform-verify-deployment.mjs WEB_MANIFEST IMAGE PROBES OUTPUT");
  const result = await verifyDeployment(JSON.parse(readFileSync(manifestPath, "utf8")), image, JSON.parse(readFileSync(probePath, "utf8")), { secret: process.env.FEED_RUNTIME_ADMIN_SECRET });
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log("Verified active Worker, immutable Container images and instance versions with bounded temporary readiness");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
