/**
 * Public event/campaign entry points that may attach a durable cohort label to
 * a scored account. Keep this allow-list server-owned: accepting arbitrary
 * client strings would let anyone create unbounded database labels.
 */
export const CAMPAIGNS = {
  advx: {
    slug: "advx",
    name: "AdventureX",
  },
} as const;

export type CampaignSlug = keyof typeof CAMPAIGNS;

export function campaignSlug(value: unknown): CampaignSlug | null {
  if (typeof value !== "string") return null;
  return value in CAMPAIGNS ? (value as CampaignSlug) : null;
}
