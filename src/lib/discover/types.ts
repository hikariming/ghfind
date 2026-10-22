export type DiscoverSource = "feed" | "public";
export type DiscoverMode = "grid" | "swipe";
export type DiscoverAction = "like" | "skip" | "superlike";
export type DiscoverBanner = "signed_out" | "feed_unavailable" | null;

export type DiscoverTag = {
  id: string;
  label: string;
};

export type DiscoverCard = {
  repoKey: string;
  ownerLogin: string;
  name: string;
  summary: string;
  hook: string;
  audience: string | null;
  coverUrl: string | null;
  language: string | null;
  tags: DiscoverTag[];
  productScore: number;
  confidence: number;
  communityStrength: number | null;
  canonicalUrl: string;
  analysisId: string | null;
  impressionToken: string | null;
  source: DiscoverSource;
  verificationLevel: string | null;
};

export type DiscoverPage = {
  items: DiscoverCard[];
  nextCursor: string | null;
  nextOffset: number | null;
  source: DiscoverSource;
  degraded: string[];
  requestId: string | null;
};

export type DiscoverHistoryEntry = {
  card: DiscoverCard;
  action: DiscoverAction;
};
