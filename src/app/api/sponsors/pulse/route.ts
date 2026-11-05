import { isBotUserAgent } from "@/lib/bot-user-agent";
import { getD1Binding } from "@/lib/d1-client";
import { beijingDay, countSlotHits, parseSlotHits, STATIC_SLOTS, type SlotCount } from "@/lib/slot-metrics";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const MAX_BODY_BYTES = 8 * 1024;

const UPSERT = `ON CONFLICT(day, ad_kind, ad_id, placement) DO UPDATE SET
  impressions = impressions + excluded.impressions,
  clicks = clicks + excluded.clicks,
  updated_at = excluded.updated_at`;

/**
 * Each statement resolves the slot's advertiser from its own table, so an id
 * that doesn't exist inserts nothing — callers can't mint arbitrary rows.
 * (`WHERE` before `ON CONFLICT` is what lets SQLite parse an upsert-select.)
 */
const ADVERTISER_SOURCE: Record<Exclude<SlotCount["kind"], "static">, { advertiser: string; table: string }> = {
  sponsor: { advertiser: "COALESCE(advertiser_id, id)", table: "sponsorships" },
  job: { advertiser: "company_id", table: "jobs" },
  company: { advertiser: "id", table: "job_companies" },
};

const INSERT =
  "INSERT INTO ad_daily_stats (day, ad_kind, ad_id, placement, advertiser, impressions, clicks, updated_at)";

/**
 * Sponsored-slot impressions and clicks from src/components/SlotMetrics.tsx,
 * sent with `navigator.sendBeacon` as text/plain JSON. Same-origin browsers
 * only; crawler UAs are dropped. Always 204 on accepted input so a beacon
 * never retries. Counts are a best-effort rollup, not billing-grade: a
 * determined script can still inflate them.
 */
export async function POST(request: Request) {
  // Sec-Fetch-Site, not Origin vs request.url: behind the router Worker and in
  // `next dev` the request URL's host differs from the page's, so an Origin
  // comparison 403s every real beacon.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "cross_origin_request" }, { status: 403, headers: NO_STORE });
  }
  if (isBotUserAgent(request.headers.get("user-agent"))) {
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }
  const hits = parseSlotHits(body);
  if (!hits) return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });

  const db = getD1Binding();
  if (!db) {
    return Response.json({ error: "Sponsor data is unavailable in this runtime." }, { status: 503, headers: NO_STORE });
  }

  const now = Date.now();
  const day = beijingDay(now);
  const statements = countSlotHits(hits).map((row) => {
    if (row.kind === "static") {
      return db
        .prepare(`${INSERT} VALUES (?, ?, ?, ?, ?, ?, ?, ?) ${UPSERT}`)
        .bind(day, row.kind, row.id, row.placement, STATIC_SLOTS[row.id], row.impressions, row.clicks, now);
    }
    const { advertiser, table } = ADVERTISER_SOURCE[row.kind];
    return db
      .prepare(`${INSERT} SELECT ?, ?, ?, ?, ${advertiser}, ?, ?, ? FROM ${table} WHERE id = ? ${UPSERT}`)
      .bind(day, row.kind, row.id, row.placement, row.impressions, row.clicks, now, row.id);
  });

  try {
    await db.batch(statements);
  } catch {
    return Response.json({ error: "Sponsor metrics could not be saved." }, { status: 500, headers: NO_STORE });
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}
