import { NextResponse } from "next/server";
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

export async function GET() {
  const db = getD1Binding();
  if (!db) {
    return NextResponse.json(
      { error: "Sponsor data is unavailable in this runtime." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const asOf = Date.now();
  try {
    const tierOrder = SPONSOR_TIER_ORDER.map((tier, index) => `WHEN '${tier}' THEN ${index}`).join(" ");
    const { results } = await db
      .prepare(
        `SELECT id, tier, sponsor_name, sponsor_url, icon_url, mark, description,
                is_anonymous, is_perpetual, started_at, expires_at
         FROM sponsorships
         WHERE (started_at IS NULL OR started_at <= ?)
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY CASE tier ${tierOrder} ELSE ${SPONSOR_TIER_ORDER.length} END,
                  COALESCE(started_at, 0), created_at, id`,
      )
      .bind(asOf, asOf)
      .all();

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

    return NextResponse.json(
      { sponsors, asOf },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Sponsor data could not be loaded." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
