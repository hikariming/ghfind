const REQUEST_TIMEOUT_MS = 15_000;

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

function baseUrl(): URL {
  const url = new URL(required("SMOKE_BASE_URL"));
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SMOKE_BASE_URL must contain only an origin");
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

async function runCheck(base: URL, check: Check): Promise<void> {
  const response = await fetch(new URL(check.path, base), {
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: "application/json, text/html;q=0.9" },
  });
  if (response.status !== check.status) {
    throw new Error(`${check.label} returned ${response.status}; expected ${check.status}`);
  }
  if (response.url.includes("localhost") || response.url.includes("127.0.0.1")) {
    throw new Error(`${check.label} resolved to a local origin`);
  }
  if (check.validate) {
    const body = await response.json();
    check.validate(body, response);
  }
  console.log(`PASS ${check.label}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    usage();
    return;
  }

  const base = baseUrl();
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
  ];

  for (const check of checks) await runCheck(base, check);
  console.log(`PASS deployment smoke (${checks.length} checks)`);
}

main().catch((error: unknown) => {
  console.error(`FAIL deployment smoke: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
