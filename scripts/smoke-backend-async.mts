import { createHash } from "node:crypto";

const REQUEST_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 180_000;

function usage(): void {
  console.log("Run with SMOKE_BASE_URL, SMOKE_SCAN_USERNAME, SMOKE_MACHINE_API_KEY, SMOKE_BACKEND_BASE_URL and SMOKE_WORKER_METRICS_BASE_URL");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function originUrl(name: string): URL {
  const raw = required(name);
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must contain only an origin`);
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    if (process.env.SMOKE_ALLOW_HTTP !== "1") {
      throw new Error("localhost smoke requires SMOKE_ALLOW_HTTP=1");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("remote async smoke requires HTTPS");
  }
  url.pathname = "/";
  return url;
}

function handle(value: string, variable: string): string {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value)) {
    throw new Error(`${variable} is not a valid handle`);
  }
  return value.toLowerCase();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("response must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function scanJobID(username: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`scan.quick.v1\0${username}\0${idempotencyKey}`)
    .digest("hex");
  return `job_${digest.slice(0, 32)}`;
}

function requireScanResult(body: unknown, username: string): void {
  const payload = record(body);
  if (payload.cached === true && process.env.SMOKE_ALLOW_CACHED_SCAN !== "1") {
    throw new Error("scan response was cached; use a cold canary or set SMOKE_ALLOW_CACHED_SCAN=1 for a non-admission check");
  }
  const metrics = record(payload.metrics);
  const scoring = record(payload.scoring);
  if (String(metrics.username).toLowerCase() !== username) {
    throw new Error("scan result returned the wrong username");
  }
  if (typeof scoring.final_score !== "number") {
    throw new Error("scan result is missing final_score");
  }
}

function requireCompletedStatus(body: unknown, username: string): void {
  const payload = record(body);
  const status = record(payload.status);
  if (status.kind !== "scan.quick.v1") {
    throw new Error("scan job status kind is not scan.quick.v1");
  }
  if (String(status.username).toLowerCase() !== username) {
    throw new Error("scan job status returned the wrong username");
  }
  if (status.state === "failed") {
    throw new Error(`scan job reached failed terminal state: ${String(status.error ?? "")}`);
  }
  if (status.state !== "completed") {
    throw new Error(`scan job is ${String(status.state)}, not completed`);
  }
  requireScanResult(record(payload).result, username);
}

async function fetchJSON(url: URL, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${url.pathname} did not return JSON`);
  }
  return { response, body };
}

async function pollScanJob(base: URL, jobID: string, username: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { response, body } = await fetchJSON(new URL(`/api/scan/jobs/${encodeURIComponent(jobID)}`, base));
    if (response.status !== 200) {
      throw new Error(`scan job status returned ${response.status}`);
    }
    const state = String(record(record(body).status).state);
    if (state === "completed") {
      requireCompletedStatus(body, username);
      console.log("PASS async scan job completed");
      return;
    }
    if (state === "failed") {
      requireCompletedStatus(body, username);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("scan job did not complete before the async smoke timeout");
}

async function requireMetrics(base: URL, label: string, requiredSnippets: string[]): Promise<void> {
  const response = await fetch(new URL("/metrics", base), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: "text/plain" },
  });
  if (response.status !== 200) {
    throw new Error(`${label} metrics returned ${response.status}`);
  }
  if ((response.headers.get("cache-control") ?? "") !== "no-store") {
    throw new Error(`${label} metrics must be no-store`);
  }
  const text = await response.text();
  for (const snippet of requiredSnippets) {
    if (!text.includes(snippet)) {
      throw new Error(`${label} metrics missing ${snippet}`);
    }
  }
  console.log(`PASS ${label} async metrics`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    usage();
    return;
  }

  const base = originUrl("SMOKE_BASE_URL");
  const backend = originUrl("SMOKE_BACKEND_BASE_URL");
  const worker = originUrl("SMOKE_WORKER_METRICS_BASE_URL");
  const username = handle(required("SMOKE_SCAN_USERNAME"), "SMOKE_SCAN_USERNAME");
  const apiKey = required("SMOKE_MACHINE_API_KEY");
  const idempotencyKey =
    optional("SMOKE_IDEMPOTENCY_KEY") ?? `staging-async-${username}-${Date.now()}`;
  const expectedJobID = scanJobID(username, idempotencyKey);

  const { response, body } = await fetchJSON(new URL("/api/scan", base), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ username }),
  });

  if (response.status === 202) {
    const location = response.headers.get("location") ?? "";
    if (location !== `/api/scan/jobs/${expectedJobID}`) {
      throw new Error("202 scan response did not expose the expected public job Location");
    }
    console.log("PASS async scan admitted");
  } else if (response.status === 200) {
    requireScanResult(body, username);
    console.log("PASS async scan returned worker result");
  } else {
    throw new Error(`scan admission returned ${response.status}`);
  }

  await pollScanJob(base, expectedJobID, username);
  await requireMetrics(backend, "backend", [
    'ghfind_api_job_admissions_total{kind="scan.quick.v1",result="queued"}',
  ]);
  await requireMetrics(worker, "worker", [
    'ghfind_worker_jobs_completed_total{kind="scan.quick.v1"',
    'ghfind_worker_job_duration_seconds_count{kind="scan.quick.v1"}',
  ]);
  console.log("PASS backend async smoke");
}

main().catch((error: unknown) => {
  console.error(`FAIL backend async smoke: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
