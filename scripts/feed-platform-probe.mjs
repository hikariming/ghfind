#!/usr/bin/env node
// Bounded staging-only lifecycle probes. Never use this against production.
import { readFileSync, writeFileSync } from "node:fs";
import { validateManifest, validateImage } from "./feed-platform-manifest.mjs";
const [manifestPath, baseURL, sha, image, output] = process.argv.slice(2);
const manifest = validateManifest(
  JSON.parse(readFileSync(manifestPath, "utf8")),
);
validateImage(image);
const url = new URL(baseURL);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.port ||
  url.pathname !== "/" ||
  url.search ||
  url.hash ||
  !url.hostname.startsWith(`${manifest.runtimeWorker}.`) ||
  !url.hostname.endsWith(".workers.dev")
)
  throw new Error(
    "Only the exact isolated staging workers.dev origin may be probed",
  );
if (!/^[a-f0-9]{40}$/.test(sha))
  throw new Error("Exact release SHA is required");
const secret = process.env.FEED_RUNTIME_ADMIN_SECRET;
if (!secret || Buffer.byteLength(secret) < 32)
  throw new Error("Runtime operations secret required");
const observations = [];
async function request(path, method = "GET") {
  const started = performance.now();
  const response = await fetch(new URL(path, url), {
    method,
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`Probe ${path}: HTTP ${response.status}`);
  const data = await response.json();
  observations.push({
    path,
    method,
    durationMs: Math.round(performance.now() - started),
    status: response.status,
    observedAt: new Date().toISOString(),
  });
  return data;
}
function version(data, target) {
  if (
    data.ready !== true ||
    data.version !== sha ||
    data.contractVersion !== "1" ||
    data.storageWriterVersion !== 2 ||
    data.storeProfile !== "cf_d1_r2" ||
    String(data.writerEpoch) !== "1" ||
    data.service !== (target === "executor-0" ? "feed-worker" : "feed-api")
  )
    throw new Error(`Readiness/version mismatch: ${target}`);
}
const targets = ["api-0", "api-1", "executor-0"];
let successful = false;
let workerVersionId;
try {
  // Provisioning may take minutes; this is a readiness wait, not a cold-SLO sample.
  let ready;
  for (let attempt = 0; attempt < 18; attempt++) {
    try {
      ready = await request("/readyz");
      break;
    } catch (error) {
      if (attempt === 17) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
  if (
    ready.version !== sha ||
    ready.contractVersion !== "1" ||
    ready.configuredImage !== image ||
    !ready.workerVersionId
  )
    throw new Error("Runtime release identity mismatch");
  workerVersionId = ready.workerVersionId;
  for (const target of targets) {
    await request(`/internal/runtime/${target}/stop`, "POST");
    // Server has awaited Container.stop(SIGTERM). The next request must start it.
    version(await request(`/internal/runtime/${target}/ready`), target);
  }
  for (let wave = 0; wave < 3; wave++) {
    await Promise.all(
      targets.flatMap((target) =>
        Array.from({ length: 2 }, async () =>
          version(await request(`/internal/runtime/${target}/ready`), target),
        ),
      ),
    );
  }
  successful = true;
} finally {
  const result = {
    schemaVersion: 1,
    kind: "bounded-runtime-probes",
    releaseSHA: sha,
    configuredImage: image,
    workerVersionId,
    successful,
    observations,
    limits: {
      provisioningAttempts: 18,
      lifecycleStopCalls: 3,
      concurrentRequests: 6,
      waves: 3,
    },
    notProven: [
      "real OAuth",
      "real project assessment",
      "durable task fault recovery",
      "load-test SLO",
      "monthly costs",
      "temporary-disk-loss correctness",
    ],
    coldStartTargetMs: 5000,
    normalP95TargetMs: 800,
  };
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
}
console.log(
  "Bounded staging lifecycle/version/concurrency probes passed; this is not full Feed acceptance",
);
