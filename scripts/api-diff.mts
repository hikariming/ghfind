/**
 * API contract parity between two deployments — the gate for moving an /api
 * route from the Next Worker to the Hono API Worker (Astro migration P1).
 *
 *   pnpm tsx scripts/api-diff.mts <baseA> <baseB> [--sites=https://ghfind.com,...]
 *
 * For every case below it compares status, the headers clients and CDNs act
 * on, and the JSON body (deep, key-order-insensitive). Volatile fields that
 * legitimately differ between two back-to-back requests are ignored. Hosts are
 * normalized like scripts/seo-diff.mts. Exits 1 on any diff.
 */

const argv = process.argv.slice(2);
const [baseA, baseB] = argv.filter((a) => !a.startsWith("--"));
if (!baseA || !baseB) {
  console.error("usage: api-diff.mts <baseA> <baseB> [--sites=origin,...]");
  process.exit(2);
}
const sites = argv.find((a) => a.startsWith("--sites="))?.slice(8).split(",").map((s) => new URL(s).origin) ?? [];

type Case = { method?: string; path: string };

const CASES: Case[] = [
  { path: "/api/stats" },
  { path: "/api/leaderboard" },
  { path: "/api/leaderboard?view=score&window=7d&limit=5&offset=2" },
  { path: "/api/leaderboard?view=heat&limit=abc" },
  { path: "/api/search-users?q=tor" },
  { path: "/api/search-users?q=" },
  { path: "/api/developers" },
  { path: "/api/developers?type=language" },
  { path: "/api/developers?type=language&value=Rust&limit=3" },
  { path: "/api/talent?overview=1" },
  { path: "/api/talent?page=0&pageSize=5&sort=stars" },
  { path: "/api/sponsors" },
  { path: "/api/facet-rank/torvalds" },
  { path: "/api/facet-rank/%E2%9C%93" },
  { path: "/api/campaigns/advx/leaderboard" },
  { path: "/api/campaigns/advx/leaderboard?limit=0100" },
  { path: "/api/campaigns/advx/leaderboard?offset=600" },
  { path: "/api/campaigns/nope/leaderboard" },
  { method: "HEAD", path: "/api/leaderboard" },
  { method: "OPTIONS", path: "/api/stats" },
  { method: "POST", path: "/api/stats" },
  { path: "/api/does-not-exist" },
];

const HEADERS = ["content-type", "cache-control", "allow", "location", "www-authenticate", "link", "retry-after"];

// Differ between two back-to-back requests by design: server clocks, and
// whether the first request already warmed the Redis cache for the second.
const VOLATILE_KEYS = new Set(["asOf", "cached"]);

// Time-decayed scores (e.g. trending_score) are computed at query time, so
// two requests seconds apart drift in the ~6th significant digit.
const FLOAT_REL_TOLERANCE = 1e-6;

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number" && !(Number.isInteger(a) && Number.isInteger(b))) {
    return Math.abs(a - b) <= FLOAT_REL_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

function normalize(text: string, base: string): string {
  let out = text;
  for (const host of [...sites, new URL(base).origin]) out = out.split(host).join("{host}");
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => !VOLATILE_KEYS.has(k))
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

async function snapshot(base: string, c: Case) {
  const res = await fetch(new URL(c.path, base), { method: c.method ?? "GET", redirect: "manual" });
  const headers = Object.fromEntries(
    HEADERS.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null),
  ) as Record<string, string>;
  // content-type parameters (charset spacing/case) are not part of the contract.
  if (headers["content-type"]) headers["content-type"] = headers["content-type"].split(";")[0].trim().toLowerCase();
  if (headers.location) headers.location = new URL(headers.location, base).pathname + new URL(headers.location, base).search;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = canonical(JSON.parse(text));
  } catch {
    // non-JSON bodies compare as text (empty for HEAD/OPTIONS/405)
  }
  return JSON.parse(normalize(JSON.stringify({ status: res.status, headers, body }), base));
}

let diffs = 0;
for (const c of CASES) {
  const label = `${c.method ?? "GET"} ${c.path}`;
  const [a, b] = [await snapshot(baseA, c), await snapshot(baseB, c)];
  const fields = ["status", ...new Set([...Object.keys(a.headers), ...Object.keys(b.headers)]).values()].map((f) =>
    f === "status" ? ["status", a.status, b.status] : [`header ${f}`, a.headers[f], b.headers[f]],
  );
  fields.push(["body", a.body, b.body]);
  const bad = fields.filter(([, x, y]) => !same(x, y));
  if (!bad.length) {
    console.log(`✓ ${label} (${a.status})`);
    continue;
  }
  diffs += bad.length;
  console.log(`✗ ${label}`);
  for (const [f, x, y] of bad) {
    const show = (v: unknown) => (JSON.stringify(v) ?? "∅").slice(0, 300);
    console.log(`    ${f}\n      A: ${show(x)}\n      B: ${show(y)}`);
  }
}

console.log(`\n${CASES.length} cases, ${diffs} diff(s).`);
process.exit(diffs ? 1 : 0);
