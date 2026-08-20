const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 5_000;

type Check = {
  label: string;
  path: string;
  status: number;
  validate?: (body: unknown, response: Response) => void;
};

function usage(): void {
  console.log("Run with private SMOKE_* environment variables; see docs/releases/deployment-smoke.md");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("response must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function handle(value: string, variable: string): string {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value)) {
    throw new Error(`${variable} is not a valid handle`);
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function publicSmokeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const bypass = optional("VERCEL_AUTOMATION_BYPASS_SECRET");
  return bypass ? { ...extra, "x-vercel-protection-bypass": bypass } : extra;
}

function originUrl(name: string, requiredValue: boolean): URL | null {
  const raw = requiredValue ? required(name) : optional(name);
  if (!raw) return null;
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must contain only an origin`);
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    if (process.env.SMOKE_ALLOW_HTTP !== "1") {
      throw new Error("localhost smoke requires SMOKE_ALLOW_HTTP=1");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("remote deployment smoke requires HTTPS");
  }
  url.pathname = "/";
  return url;
}

async function runCheck(base: URL, check: Check, vercelProtected = false): Promise<void> {
  const response = await fetch(new URL(check.path, base), {
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: vercelProtected
      ? publicSmokeHeaders({ Accept: "application/json, text/html;q=0.9" })
      : { Accept: "application/json, text/html;q=0.9" },
  });
  if (response.status !== check.status) {
    throw new Error(`${check.label} returned ${response.status}; expected ${check.status}`);
  }
  if (
    base.hostname !== "localhost" &&
    base.hostname !== "127.0.0.1" &&
    (response.url.includes("localhost") || response.url.includes("127.0.0.1"))
  ) {
    throw new Error(`${check.label} resolved to a local origin`);
  }
  if (check.validate) {
    const body = await response.json();
    check.validate(body, response);
  }
  console.log(`PASS ${check.label}`);
}

async function runMcpCheck(base: URL): Promise<void> {
  const response = await fetch(new URL("/mcp", base), {
    method: "POST",
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: publicSmokeHeaders({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (response.status !== 200) {
    throw new Error(`mcp tools/list returned ${response.status}; expected 200`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error("mcp tools/list did not return an SSE response");
  }
  const text = await response.text();
  if (!text.includes("data:") || !text.includes('"tools"') || !text.includes("score_user")) {
    throw new Error("mcp tools/list response is missing tool data");
  }
  console.log("PASS mcp tools/list");
}

async function runCampaignSseCheck(base: URL, campaign: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(`/api/campaigns/${encodeURIComponent(campaign)}/leaderboard/events`, base), {
      headers: publicSmokeHeaders({ Accept: "text/event-stream" }),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new Error(`campaign SSE returned ${response.status}; expected 200`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new Error("campaign SSE did not return text/event-stream");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("campaign SSE response body is not readable");
    const first = await reader.read();
    await reader.cancel().catch(() => undefined);
    const chunk = new TextDecoder().decode(first.value ?? new Uint8Array());
    if (!chunk.includes("retry: 2000")) {
      throw new Error("campaign SSE did not emit the reconnect hint");
    }
    console.log("PASS campaign SSE");
  } finally {
    clearTimeout(timer);
  }
}

async function runBackendProcessCheck(base: URL, label: string): Promise<void> {
  await runCheck(base, {
    label: `${label} health`,
    path: "/healthz",
    status: 200,
    validate(body) {
      if (record(body).ok !== true) throw new Error(`${label} health body is not ok`);
    },
  });
  await runCheck(base, {
    label: `${label} readiness`,
    path: "/readyz",
    status: 200,
    validate(body) {
      if (record(body).ready !== true) throw new Error(`${label} readiness body is not ready`);
    },
  });
  const metrics = await fetch(new URL("/metrics", base), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: "text/plain" },
  });
  if (metrics.status !== 200) {
    throw new Error(`${label} metrics returned ${metrics.status}; expected 200`);
  }
  if (!(metrics.headers.get("content-type") ?? "").includes("text/plain")) {
    throw new Error(`${label} metrics did not return text/plain`);
  }
  if (metrics.headers.get("cache-control") !== "no-store") {
    throw new Error(`${label} metrics must be no-store`);
  }
  await metrics.text();
  console.log(`PASS ${label} metrics`);
}

async function runWorkerMetricsCheck(base: URL): Promise<void> {
  const metrics = await fetch(new URL("/metrics", base), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: "text/plain" },
  });
  if (metrics.status !== 200) {
    throw new Error(`worker metrics returned ${metrics.status}; expected 200`);
  }
  if (!(metrics.headers.get("content-type") ?? "").includes("text/plain")) {
    throw new Error("worker metrics did not return text/plain");
  }
  if (metrics.headers.get("cache-control") !== "no-store") {
    throw new Error("worker metrics must be no-store");
  }
  await metrics.text();
  console.log("PASS worker metrics");
}

function validateScanJob(body: unknown): void {
  const payload = record(body);
  const status = record(payload.status);
  if (status.kind !== "scan.quick.v1") {
    throw new Error("scan job status is not a public scan job");
  }
  const state = String(status.state);
  if (!new Set(["queued", "running", "retrying", "completed", "failed"]).has(state)) {
    throw new Error("scan job status state is invalid");
  }
  const expectedUsername = optional("SMOKE_SCAN_JOB_USERNAME");
  if (expectedUsername && String(status.username).toLowerCase() !== expectedUsername.toLowerCase()) {
    throw new Error("scan job status returned the wrong username");
  }
  if (process.env.SMOKE_SCAN_JOB_EXPECT_RESULT === "1") {
    if (state !== "completed") throw new Error("scan job is not completed");
    const result = record(payload.result);
    const metrics = record(result.metrics);
    const scoring = record(result.scoring);
    if (!metrics.username || typeof scoring.final_score !== "number") {
      throw new Error("scan job result is missing scan metrics/scoring");
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    usage();
    return;
  }

  const base = originUrl("SMOKE_BASE_URL", true);
  if (!base) throw new Error("SMOKE_BASE_URL is required");
  if (process.env.SMOKE_REQUIRE_VERCEL_BYPASS === "1" && !optional("VERCEL_AUTOMATION_BYPASS_SECRET")) {
    throw new Error("VERCEL_AUTOMATION_BYPASS_SECRET is required for protected production smoke");
  }
  const canary = handle(required("SMOKE_CANARY_HANDLE"), "SMOKE_CANARY_HANDLE");
  const facetType = required("SMOKE_FACET_TYPE");
  if (!new Set(["language", "org", "repo"]).has(facetType)) {
    throw new Error("SMOKE_FACET_TYPE must be language, org, or repo");
  }
  const facetValue = required("SMOKE_FACET_VALUE");
  const expectedOrigin = base.origin;
  const checks: Check[] = [
    {
      label: "profile",
      path: `/u/${encodeURIComponent(canary)}`,
      status: 200,
    },
    {
      label: "score API and canonical origin",
      path: `/api/score/${encodeURIComponent(canary)}`,
      status: 200,
      validate(body) {
        const payload = record(body);
        if (String(payload.username).toLowerCase() !== canary.toLowerCase()) {
          throw new Error("score API returned the wrong canary");
        }
        const profile = new URL(String(payload.profile));
        if (profile.origin !== expectedOrigin) {
          throw new Error("score API canonical profile origin does not match deployment origin");
        }
      },
    },
    {
      label: "profile presentation API",
      path: `/api/profile/${encodeURIComponent(canary)}`,
      status: 200,
      validate(body) {
        const detail = record(record(body).detail);
        if (String(detail.username).toLowerCase() !== canary.toLowerCase()) {
          throw new Error("profile presentation returned the wrong canary");
        }
        if (typeof detail.final_score !== "number") {
          throw new Error("profile presentation is missing final_score");
        }
      },
    },
    {
      label: "badge embed API",
      path: `/api/embed/badge/${encodeURIComponent(canary)}`,
      status: 200,
      validate(body) {
        const payload = record(body);
        if (!("final_score" in payload) || !("tier" in payload) || !("delta" in payload)) {
          throw new Error("badge embed API is missing expected keys");
        }
      },
    },
    {
      label: "autocomplete",
      path: `/api/search-users?q=${encodeURIComponent(canary.slice(0, 6))}`,
      status: 200,
      validate(body) {
        if (!Array.isArray(record(body).users)) throw new Error("autocomplete users are missing");
      },
    },
    {
      label: "score leaderboard",
      path: "/api/leaderboard?view=score&limit=1",
      status: 200,
      validate(body) {
        if (!Array.isArray(record(body).entries)) throw new Error("leaderboard entries are missing");
      },
    },
    {
      label: "facet bucket",
      path: `/api/developers?type=${encodeURIComponent(facetType)}&value=${encodeURIComponent(facetValue)}&limit=1`,
      status: 200,
      validate(body) {
        if (!Array.isArray(record(body).entries)) throw new Error("facet entries are missing");
      },
    },
    {
      label: "projects API",
      path: "/api/projects?limit=1",
      status: 200,
      validate(body) {
        if (!Array.isArray(record(body).projects)) throw new Error("projects are missing");
      },
    },
    {
      label: "sitemap inventory API",
      path: "/api/sitemap",
      status: 200,
      validate(body) {
        const payload = record(body);
        if (!Array.isArray(payload.profiles) || !Array.isArray(payload.matchups)) {
          throw new Error("sitemap inventory arrays are missing");
        }
      },
    },
  ];

  for (const check of checks) await runCheck(base, check, true);
  await runMcpCheck(base);
  await runCampaignSseCheck(base, optional("SMOKE_CAMPAIGN") || "advx");

  const scanJobID = optional("SMOKE_SCAN_JOB_ID");
  if (scanJobID) {
    await runCheck(base, {
      label: "public scan job status",
      path: `/api/scan/jobs/${encodeURIComponent(scanJobID)}`,
      status: 200,
      validate: validateScanJob,
    }, true);
  } else if (process.env.SMOKE_REQUIRE_SCAN_JOB === "1") {
    throw new Error("SMOKE_SCAN_JOB_ID is required when SMOKE_REQUIRE_SCAN_JOB=1");
  }

  const backend = originUrl("SMOKE_BACKEND_BASE_URL", false);
  if (backend) await runBackendProcessCheck(backend, "backend");

  const workerMetrics = originUrl("SMOKE_WORKER_METRICS_BASE_URL", false);
  if (workerMetrics) await runWorkerMetricsCheck(workerMetrics);

  console.log("PASS deployment smoke");
}

main().catch((error: unknown) => {
  console.error(`FAIL deployment smoke: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
