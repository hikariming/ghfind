export const SPONSOR_TIER_ORDER = ["夯", "顶级", "人上人", "友情"] as const;

export type SponsorTier = (typeof SPONSOR_TIER_ORDER)[number];

export interface SponsorRecord {
  id: string;
  tier: SponsorTier;
  name: string | null;
  url: string | null;
  iconUrl: string | null;
  mark: string | null;
  description: string | null;
  isAnonymous: boolean;
  isPerpetual: boolean;
  startedAt: number | null;
  expiresAt: number | null;
}

export interface SponsorsResponse {
  sponsors: SponsorRecord[];
  asOf: number;
}

/**
 * Where a sponsor cell links: a first-party hop that 302s to the sponsor URL.
 * Raw referral URLs (`/?aff=…`) are hidden by generic ad-block filters, which
 * dropped paid cells from the page; see src/app/api/sponsors/[id]/visit.
 */
export function sponsorVisitHref(sponsor: Pick<SponsorRecord, "id" | "url">): string | null {
  return sponsor.url ? `/api/sponsors/${encodeURIComponent(sponsor.id)}/visit` : null;
}
