/**
 * Commercial offer details for the sponsor page. Sponsor identities and current
 * holders are read from the sponsorship API; this file keeps only public plan
 * prices and the existing slot count.
 */

export type SponsorTierId = "title" | "model" | "featured" | "friend";

export type SponsorTier = {
  id: SponsorTierId;
  displayTier: "夯" | "顶级" | "人上人" | "友情";
  /** Struck-through regular price; omit when the tier isn't discounted. */
  listPrice?: number;
  price: number;
  soldOut: boolean;
};

export const SPONSOR_TIERS: SponsorTier[] = [
  { id: "title", displayTier: "夯", price: 500, soldOut: true },
  { id: "model", displayTier: "顶级", listPrice: 300, price: 200, soldOut: false },
  { id: "featured", displayTier: "人上人", listPrice: 60, price: 35, soldOut: false },
  { id: "friend", displayTier: "友情", listPrice: 30, price: 25, soldOut: false },
];

/** Number of cells shown in the homepage sponsor row. */
export const HOME_SPONSOR_SLOTS = 4;

export const SPONSOR_CONTACT_EMAIL = "lbm21@tsinghua.org.cn";
