const ROAST_META_HEADER = "x-roast-meta";
const FRAME = "\x1f";

export class CliHttpError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "CliHttpError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function normalizeHost(host) {
  const raw = (host || process.env.GHFIND_HOST || process.env.GITHUB_ROAST_HOST || "https://ghfind.com").trim();
  return raw.replace(/\/+$/, "");
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function decodeMeta(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function readError(response) {
  const text = await response.text().catch(() => "");
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // text body is still useful for diagnostics
  }
  const code = parsed?.error ?? null;
  const message = code
    ? `API request failed: ${code}`
    : `API request failed with HTTP ${response.status}`;
  throw new CliHttpError(message, { status: response.status, code, body: parsed ?? text });
}

export async function scanAccount(options) {
  const host = normalizeHost(options.host);
  const response = await options.fetchImpl(`${host}/api/scan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(options.apiKey),
    },
    body: JSON.stringify({
      username: options.username,
      ...(options.turnstileToken ? { turnstileToken: options.turnstileToken } : {}),
    }),
  });
  if (!response.ok) await readError(response);
  return response.json();
}

export async function roastAccount(options) {
  const host = normalizeHost(options.host);
  const response = await options.fetchImpl(`${host}/api/roast`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(options.apiKey),
    },
    body: JSON.stringify({
      scan: options.scan,
      lang: options.lang,
    }),
  });
  if (!response.ok) await readError(response);
  return parseRoastResponse(response);
}

export async function getStats(options) {
  return getJson(options, "/api/stats");
}

export async function getLeaderboard(options) {
  const params = new URLSearchParams();
  if (options.view) params.set("view", options.view);
  if (options.window) params.set("window", options.window);
  return getJson(options, `/api/leaderboard${params.size ? `?${params}` : ""}`);
}

export async function getDevelopers(options) {
  const params = new URLSearchParams({ type: options.type });
  if (options.value) params.set("value", options.value);
  return getJson(options, `/api/developers?${params}`);
}

async function getJson(options, path) {
  const host = normalizeHost(options.host);
  const response = await options.fetchImpl(`${host}${path}`, {
    method: "GET",
  });
  if (!response.ok) await readError(response);
  return response.json();
}

export async function parseRoastResponse(response) {
  const headerMeta = decodeMeta(response.headers.get(ROAST_META_HEADER));
  const text = await response.text();
  const lines = text.split("\n");
  const reportLines = [];
  const progress = [];
  let meta = headerMeta;

  for (const line of lines) {
    if (line.startsWith(`${FRAME}T`)) {
      progress.push(line.slice(2));
      continue;
    }
    if (line.startsWith(`${FRAME}M`)) {
      meta = decodeMeta(line.slice(2)) ?? meta;
      continue;
    }
    if (line.startsWith(`${FRAME}E`)) {
      const raw = line.slice(2);
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      throw new CliHttpError("Roast stream failed", {
        status: response.status,
        code: parsed?.error ?? null,
        body: parsed,
      });
    }
    reportLines.push(line);
  }

  return {
    meta,
    report: reportLines.join("\n").replace(/^\n+|\n+$/g, ""),
    progress,
  };
}
