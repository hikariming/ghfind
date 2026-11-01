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

type Case = {
  method?: string;
  path: string;
  /** Compare status/headers only: the body legitimately differs (see case). */
  ignoreBody?: boolean;
  /** Headers that legitimately differ for this case (see case). */
  ignoreHeaders?: string[];
  /** Request headers; `{origin}` becomes the origin of the base under test. */
  headers?: Record<string, string>;
  body?: string;
};

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
  // Batch 2a: README-embedded SVG images (compared as exact text).
  { path: "/api/badge/torvalds" },
  { path: "/api/badge/torvalds?lang=zh" },
  { path: "/api/badge/zz-no-such-user-0xd1ff" },
  { path: "/api/badge/bad%20name" },
  { path: "/api/card/mini/torvalds" },
  { path: "/api/card/mini/torvalds?theme=light&lang=zh" },
  { path: "/api/card/mini/torvalds?variant=radar" },
  { path: "/api/card/mini/torvalds?variant=strip&theme=auto" },
  { path: "/api/card/mini/zz-no-such-user-0xd1ff" },
  { path: "/api/material-card/torvalds" },
  { path: "/api/material-card/torvalds?theme=light" },
  { path: "/api/material-card/torvalds?preview=1" },
  { path: "/api/material-card/zz-no-such-user-0xd1ff" },
  // Batch 2b: PNG cards / OG images (compared as SHA-256 of the bytes).
  { path: "/api/card/torvalds" },
  { path: "/api/card/torvalds?theme=light" },
  { path: "/api/card/torvalds?qr=0" },
  { path: "/api/card/zz-no-such-user-0xd1ff" },
  { path: "/api/card/vs/torvalds/gaearon" },
  { path: "/api/card/vs/torvalds/gaearon?lang=zh&theme=light" },
  { path: "/api/card/vs/torvalds/zz-no-such-user-0xd1ff" },
  { path: "/api/og/blog/who-builds-dify" },
  { path: "/api/og/blog/no-such-post-0xd1ff" },
  // Next serves this force-static image from its build-time prerender: a
  // runtime render matches it visually but differs in text anti-aliasing, and
  // ISR replaces the route's Cache-Control with its own revalidate timer.
  { path: "/api/og/home", ignoreBody: true, ignoreHeaders: ["cache-control"] },
  // Batch 3: OAuth session cookies and account tokens. Set-Cookie compares
  // name + attributes (values and Expires dates redacted); the OAuth `state`
  // in redirects is random per request. Needs the same AUTH_* secrets on both.
  { path: "/api/me" },
  { path: "/api/me", headers: { Cookie: "ghfind_session=forged.signature" } },
  { method: "HEAD", path: "/api/me" },
  { path: "/api/auth/github?callbackUrl=/en/about" },
  { path: "/api/auth/github?callbackUrl=https://evil.example/x" },
  { path: "/api/auth/callback/github?state=nope&code=x" },
  { path: "/api/auth/callback/github?state=nope&code=x", headers: { Cookie: "ghfind_oauth_state=forged.signature" } },
  { method: "POST", path: "/api/auth/signout" },
  { path: "/api/auth/signout" },
  { method: "OPTIONS", path: "/api/auth/signout" },
  { path: "/api/account/tokens" },
  { path: "/api/account/tokens", headers: { Cookie: "ghfind_session=forged.signature" } },
  { method: "POST", path: "/api/account/tokens", body: "{}" },
  { method: "POST", path: "/api/account/tokens", headers: { Origin: "{origin}" }, body: "{}" },
  { method: "OPTIONS", path: "/api/account/tokens" },
  { method: "DELETE", path: "/api/account/tokens/00000000-0000-4000-8000-000000000000" },
  { method: "DELETE", path: "/api/account/tokens/00000000-0000-4000-8000-000000000000", headers: { Origin: "{origin}" } },
  { method: "OPTIONS", path: "/api/account/tokens/x" },
  // Batch 4: comments, reactions, follows, resumes, talent detail, API index.
  // Writes are compared unauthenticated/forged only (no live session here).
  // force-static + revalidate: Next replaces the handler's Cache-Control with
  // its ISR timer (s-maxage = time left until revalidation), like og/home.
  { path: "/api", ignoreHeaders: ["cache-control"] },
  { path: "/api/blog-comments/who-builds-dify" },
  { path: "/api/blog-comments/no-such-post-0xd1ff" },
  { method: "POST", path: "/api/blog-comments/who-builds-dify", body: "{}" },
  { method: "POST", path: "/api/blog-comments/who-builds-dify", headers: { Origin: "{origin}", Cookie: "ghfind_session=forged.signature" }, body: "{}" },
  { path: "/api/collection-comments/agents-heart-hands-body" },
  { path: "/api/collection-comments/no-such-collection-0xd1ff" },
  { method: "POST", path: "/api/collection-comments/agents-heart-hands-body", body: "{}" },
  { path: "/api/profile-comments/torvalds" },
  { path: "/api/profile-comments/bad%20name" },
  { method: "POST", path: "/api/profile-comments/torvalds", body: "{}" },
  { path: "/api/profile-reactions/torvalds" },
  { path: "/api/profile-reactions/torvalds", headers: { Cookie: "ghfind_session=forged.signature" } },
  { method: "PUT", path: "/api/profile-reactions/torvalds", body: "{}" },
  { method: "DELETE", path: "/api/profile-reactions/torvalds" },
  { method: "OPTIONS", path: "/api/profile-reactions/torvalds" },
  { path: "/api/follows" },
  { path: "/api/follows/torvalds" },
  { method: "PUT", path: "/api/follows/torvalds" },
  { method: "DELETE", path: "/api/follows/torvalds", headers: { Origin: "{origin}" } },
  { path: "/api/resumes" },
  { method: "PUT", path: "/api/resumes", body: "{}" },
  { path: "/api/talent/ccch1mneyyy" },
  { path: "/api/talent/ccch1mneyyy?locale=zh" },
  { path: "/api/talent/zz-no-such-talent-0xd1ff" },
  // Batch 5: only paths that fail before any GitHub/LLM work, scan admission
  // or rate-limit token is spent (both bases share the dev rate limiter).
  { path: "/api/score/torvalds" },
  { path: "/api/score/bad%20name" },
  { method: "POST", path: "/api/score/torvalds" },
  { method: "POST", path: "/api/scan", body: "not json" },
  { method: "POST", path: "/api/scan", body: '{"username":"bad name"}' },
  { method: "POST", path: "/api/scan", body: '{"username":"torvalds","campaign":"no such campaign!"}' },
  { method: "POST", path: "/api/scan", headers: { Authorization: "Bearer ghf_forged" }, body: '{"username":"torvalds"}' },
  { path: "/api/scan" },
  { method: "OPTIONS", path: "/api/scan" },
  { method: "POST", path: "/api/roast", body: "not json" },
  { method: "POST", path: "/api/roast", body: '{"username":"bad name"}' },
  { method: "POST", path: "/api/roast", headers: { Authorization: "Bearer ghf_forged" }, body: '{"username":"torvalds"}' },
  { method: "POST", path: "/api/vs-verdict", body: "not json" },
  { method: "POST", path: "/api/vs-verdict", body: '{"a":"torvalds"}' },
  { method: "POST", path: "/api/project-analyses", body: "not json" },
  { method: "POST", path: "/api/project-analyses", body: "{}" },
  { method: "POST", path: "/api/project-analyses", body: '{"repositoryUrl":"https://github.com/a/b","ref":7}' },
  { path: "/api/project-analyses/00000000-0000-4000-8000-000000000000" },
  { path: "/api/project-analyses/not-an-id" },
  { path: "/api/campaigns/advx/leaderboard/events" },
  { path: "/api/campaigns/nope/leaderboard/events" },
  { method: "POST", path: "/api/profile/backfill", body: "not json" },
  { method: "POST", path: "/api/profile/backfill", body: '{"username":"bad name"}' },
  { method: "POST", path: "/api/admin/backfill-facets" },
  { method: "POST", path: "/api/admin/backfill-profiles", headers: { "x-admin-secret": "forged" } },
  { method: "POST", path: "/api/admin/backfill-repos" },
  { method: "POST", path: "/api/admin/backfill-scores" },
  { path: "/api/internal/project-analyses/reconcile" },
  { method: "POST", path: "/api/internal/project-analyses/reconcile", headers: { Authorization: "Bearer forged" } },
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
  const origin = new URL(base).origin;
  const res = await fetch(new URL(c.path, base), {
    method: c.method ?? "GET",
    redirect: "manual",
    headers: Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k, v.replace("{origin}", origin)])),
    body: c.body,
  });
  const headers = Object.fromEntries(
    HEADERS.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null),
  ) as Record<string, string>;
  // content-type parameters (charset spacing/case) are not part of the contract.
  if (headers["content-type"]) headers["content-type"] = headers["content-type"].split(";")[0].trim().toLowerCase();
  if (headers.location) {
    const loc = new URL(headers.location, base);
    if (loc.searchParams.has("state")) loc.searchParams.set("state", "<random>");
    headers.location = loc.origin === origin ? loc.pathname + loc.search : loc.href;
  }
  const cookies = res.headers.getSetCookie().map((cookie) =>
    cookie
      .replace(/^([^=]+)=[^;]+/, "$1=<value>")
      .replace(/Expires=[^;]+/i, "Expires=<date>"),
  );
  if (cookies.length) headers["set-cookie"] = cookies.join(" | ");
  let body: unknown;
  if ((headers["content-type"] ?? "").startsWith("text/event-stream")) {
    // Long-lived SSE: the contract is the status and headers; don't wait on it.
    await res.body?.cancel();
    body = "(event stream)";
  } else if ((headers["content-type"] ?? "").startsWith("image/png")) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    body = { png: Buffer.from(digest).toString("hex"), bytes: bytes.length };
  } else {
    const text = await res.text();
    body = text;
    try {
      body = canonical(JSON.parse(text));
    } catch {
      // non-JSON bodies compare as text (empty for HEAD/OPTIONS/405)
    }
  }
  if (c.ignoreBody) body = "(ignored)";
  for (const h of c.ignoreHeaders ?? []) delete headers[h];
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
