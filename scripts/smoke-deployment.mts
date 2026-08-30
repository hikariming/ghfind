const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 5_000;

type JsonCheck = {
  label: string;
  path: string;
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

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
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

function originUrl(name: string): URL {
  const url = new URL(required(name));
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

function assertRemoteResponse(base: URL, response: Response, label: string): void {
  if (
    base.hostname !== "localhost" &&
    base.hostname !== "127.0.0.1" &&
    (response.url.includes("localhost") || response.url.includes("127.0.0.1"))
  ) {
    throw new Error(`${label} resolved to a local origin`);
  }
}

async function fetchCheck(base: URL, label: string, path: string, headers: HeadersInit = {}): Promise<Response> {
  const response = await fetch(new URL(path, base), {
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers,
  });
  if (response.status !== 200) {
    throw new Error(`${label} returned ${response.status}; expected 200`);
  }
  assertRemoteResponse(base, response, label);
  return response;
}

async function runJsonCheck(base: URL, check: JsonCheck): Promise<void> {
  const response = await fetchCheck(base, check.label, check.path, {
    Accept: "application/json, text/html;q=0.9",
  });
  const body = await response.json();
  check.validate?.(body, response);
  console.log(`PASS ${check.label}`);
}

async function runAssetCheck(base: URL, input: {
  label: string;
  path: string;
  contentType: string;
  bodyMarker: string;
}): Promise<void> {
  const response = await fetchCheck(base, input.label, input.path);
  if (!(response.headers.get("content-type") ?? "").includes(input.contentType)) {
    throw new Error(`${input.label} did not return ${input.contentType}`);
  }
  if (!(await response.text()).includes(input.bodyMarker)) {
    throw new Error(`${input.label} is missing its expected payload`);
  }
  console.log(`PASS ${input.label}`);
}

async function runMcpCheck(base: URL): Promise<void> {
  const response = await fetch(new URL("/mcp", base), {
    method: "POST",
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  if (response.status !== 200) {
    throw new Error(`mcp tools/list returned ${response.status}; expected 200`);
  }
  assertRemoteResponse(base, response, "mcp tools/list");
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
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
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new Error(`campaign SSE returned ${response.status}; expected 200`);
    }
    assertRemoteResponse(base, response, "campaign SSE");
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
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

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    usage();
    return;
  }

  const base = originUrl("SMOKE_BASE_URL");
  const canary = handle(required("SMOKE_CANARY_HANDLE"), "SMOKE_CANARY_HANDLE");
  const facetType = required("SMOKE_FACET_TYPE");
  if (!new Set(["language", "org", "repo"]).has(facetType)) {
    throw new Error("SMOKE_FACET_TYPE must be language, org, or repo");
  }
  const facetValue = required("SMOKE_FACET_VALUE");
  const expectedOrigin = base.origin;

  await fetchCheck(base, "profile", `/u/${encodeURIComponent(canary)}`, {
    Accept: "text/html",
  });
  console.log("PASS profile");

  const checks: JsonCheck[] = [
    {
      label: "score API and canonical origin",
      path: `/api/score/${encodeURIComponent(canary)}`,
      validate(body) {
        const payload = record(body);
        if (String(payload.username).toLowerCase() !== canary.toLowerCase()) {
          throw new Error("score API returned the wrong canary");
        }
        if (new URL(String(payload.profile)).origin !== expectedOrigin) {
          throw new Error("score API canonical profile origin does not match deployment origin");
        }
      },
    },
    {
      label: "autocomplete",
      path: `/api/search-users?q=${encodeURIComponent(canary.slice(0, 6))}`,
      validate(body) {
        if (!Array.isArray(record(body).users)) throw new Error("autocomplete users are missing");
      },
    },
    {
      label: "score leaderboard",
      path: "/api/leaderboard?view=score&limit=1",
      validate(body) {
        if (!Array.isArray(record(body).entries)) throw new Error("leaderboard entries are missing");
      },
    },
    {
      label: "facet bucket",
      path: `/api/developers?type=${encodeURIComponent(facetType)}&value=${encodeURIComponent(facetValue)}&limit=1`,
      validate(body) {
        if (!Array.isArray(record(body).entries)) throw new Error("facet entries are missing");
      },
    },
    {
      label: "statistics",
      path: "/api/stats",
      validate(body) {
        const total = record(body).total;
        if (total !== null && typeof total !== "number") throw new Error("statistics total is invalid");
      },
    },
    {
      label: "OpenAPI contract",
      path: "/openapi.json",
      validate(body) {
        const spec = record(body);
        if (spec.openapi !== "3.1.0") throw new Error("OpenAPI version is invalid");
        const server = Array.isArray(spec.servers) ? record(spec.servers[0]).url : null;
        if (server !== expectedOrigin) throw new Error("OpenAPI server origin does not match deployment origin");
      },
    },
  ];

  for (const check of checks) await runJsonCheck(base, check);
  await runAssetCheck(base, {
    label: "badge SVG",
    path: `/api/badge/${encodeURIComponent(canary)}`,
    contentType: "image/svg+xml",
    bodyMarker: "<svg",
  });
  await runAssetCheck(base, {
    label: "sitemap",
    path: "/sitemap.xml",
    contentType: "xml",
    bodyMarker: "<urlset",
  });
  await runAssetCheck(base, {
    label: "agent instructions",
    path: "/llms.txt",
    contentType: "text/plain",
    bodyMarker: `${expectedOrigin}/api/score/{username}`,
  });
  await runMcpCheck(base);
  await runCampaignSseCheck(base, optional("SMOKE_CAMPAIGN") || "advx");
  console.log("PASS deployment smoke");
}

main().catch((error: unknown) => {
  console.error(`FAIL deployment smoke: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
