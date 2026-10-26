import { getD1Binding } from "@/lib/d1-client";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

/**
 * First-party hop for sponsor links. Sponsor URLs often carry referral params
 * (`/?aff=…`) that generic ad-block cosmetic filters (EasyList China:
 * `a[href*="/?aff="][target="_blank"]`) hide, which silently dropped paid
 * cells from the homepage row. Links point here instead and we 302 to the
 * stored URL. Only an active, non-anonymous sponsorship's own http(s) URL is
 * ever a target, so this is not an open redirect.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    return Response.json({ error: "invalid_id" }, { status: 400, headers: NO_STORE });
  }
  const db = getD1Binding();
  if (!db) {
    return Response.json({ error: "Sponsor data is unavailable in this runtime." }, { status: 503, headers: NO_STORE });
  }
  const now = Date.now();
  try {
    const { results } = await db
      .prepare(
        `SELECT sponsor_url FROM sponsorships
         WHERE id = ? AND is_anonymous = 0
           AND (started_at IS NULL OR started_at <= ?)
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .bind(id, now, now)
      .all();
    const stored = results[0]?.sponsor_url;
    const target = typeof stored === "string" && stored ? safeHttpUrl(stored) : null;
    if (!target) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    return new Response(null, { status: 302, headers: { ...NO_STORE, Location: target } });
  } catch {
    return Response.json({ error: "Sponsor data could not be loaded." }, { status: 500, headers: NO_STORE });
  }
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
