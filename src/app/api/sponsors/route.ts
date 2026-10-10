import { LOCALES } from "@ghfind/i18n";
import { getD1Binding } from "@/lib/d1-client";
import { SPONSOR_TIER_ORDER, type SponsorRecord, type SponsorTier } from "@/lib/sponsorships";

export const dynamic = "force-dynamic";

interface SponsorRow extends Record<string, unknown> {
  id: string;
  tier: SponsorTier;
  sponsor_name: string | null;
  sponsor_url: string | null;
  icon_url: string | null;
  mark: string | null;
  description: string | null;
  is_anonymous: number;
  is_perpetual: number;
  started_at: number | null;
  expires_at: number | null;
}

const nullableString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const isLocale = (value: string | null): value is (typeof LOCALES)[number] =>
  (LOCALES as readonly string[]).includes(value ?? "");

/**
 * `?locale=` picks per-locale copy from sponsorship_translations (falling back
 * to en, then the sponsorships row). If that table isn't migrated yet the
 * untranslated query still serves, so the sponsor row never disappears.
 */
export async function GET(request?: Request) {
  const requested = request ? new URL(request.url).searchParams.get("locale") : null;
  const locale = isLocale(requested) ? requested : null;
  const db = getD1Binding();
  if (!db) {
    return Response.json(
      { error: "Sponsor data is unavailable in this runtime." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const asOf = Date.now();
  try {
    const tierOrder = SPONSOR_TIER_ORDER.map((tier, index) => `WHEN '${tier}' THEN ${index}`).join(" ");
    const listing = (name: string, description: string, joins: string) =>
      `SELECT s.id, s.tier, ${name} AS sponsor_name, s.sponsor_url, s.icon_url, s.mark,
              ${description} AS description, s.is_anonymous, s.is_perpetual,
              s.started_at, s.expires_at
       FROM sponsorships s ${joins}
       WHERE (s.started_at IS NULL OR s.started_at <= ?)
         AND (s.expires_at IS NULL OR s.expires_at > ?)
       ORDER BY CASE s.tier ${tierOrder} ELSE ${SPONSOR_TIER_ORDER.length} END,
                s.display_order, COALESCE(s.started_at, 0), s.created_at, s.id`;
    const base = () =>
      db.prepare(listing("s.sponsor_name", "s.description", "")).bind(asOf, asOf).all();
    const { results } = locale
      ? await db
          .prepare(
            listing(
              "COALESCE(t.sponsor_name, te.sponsor_name, s.sponsor_name)",
              "COALESCE(t.description, te.description, s.description)",
              `LEFT JOIN sponsorship_translations t ON t.sponsorship_id = s.id AND t.locale = ?
               LEFT JOIN sponsorship_translations te ON te.sponsorship_id = s.id AND te.locale = 'en'`,
            ),
          )
          .bind(locale, asOf, asOf)
          .all()
          .catch(base)
      : await base();

    const sponsors: SponsorRecord[] = (results as SponsorRow[]).map((row) => {
      const isAnonymous = row.is_anonymous === 1;
      return {
        id: row.id,
        tier: row.tier,
        name: isAnonymous ? null : nullableString(row.sponsor_name),
        url: isAnonymous ? null : nullableString(row.sponsor_url),
        iconUrl: isAnonymous ? null : nullableString(row.icon_url),
        mark: isAnonymous ? null : nullableString(row.mark),
        description: isAnonymous ? null : nullableString(row.description),
        isAnonymous,
        isPerpetual: row.is_perpetual === 1,
        startedAt: nullableNumber(row.started_at),
        expiresAt: nullableNumber(row.expires_at),
      };
    });

    return Response.json(
      { sponsors, asOf },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Sponsor data could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
