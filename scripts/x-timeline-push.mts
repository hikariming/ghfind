import { readFile } from "node:fs/promises";

/**
 * Push one X timeline batch (see docs/operations/x-timeline.md) and print
 * what was kept and why the rest was not.
 *
 *   GHFIND_BASE_URL=https://dev.ghfind.com GHFIND_ADMIN_SECRET=… \
 *     pnpm tsx scripts/x-timeline-push.mts batch.json [--dry-run]
 */
const [file, ...flags] = process.argv.slice(2);
const base = process.env.GHFIND_BASE_URL?.trim();
const secret = process.env.GHFIND_ADMIN_SECRET?.trim();
if (!file || !base || !secret) {
  console.error("usage: GHFIND_BASE_URL=… GHFIND_ADMIN_SECRET=… tsx scripts/x-timeline-push.mts batch.json [--dry-run]");
  process.exit(2);
}

const body = await readFile(file, "utf8");
JSON.parse(body);
const url = new URL("/api/internal/x-timeline", base);
if (flags.includes("--dry-run")) url.searchParams.set("dryRun", "1");
const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-secret": secret },
  body,
});
const result = await response.json().catch(() => null);
console.log(JSON.stringify({ status: response.status, ...(result ?? {}) }, null, 2));
process.exit(response.ok ? 0 : 1);
