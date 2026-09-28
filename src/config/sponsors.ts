/**
 * Sponsorship tiers for the /sponsor page — prices, sold-out state and who
 * currently holds each slot. Copy (names, perks) lives in the `sponsor` i18n
 * namespace keyed by `id`; this file only carries the facts that change when a
 * deal is signed. Prices are USD per month.
 */

import { SPONSOR } from "@/lib/sponsor";

export type SponsorTierId = "title" | "model" | "featured" | "friend";

export type SponsorHolder = {
  /** Key into `sponsor.holders` for the localized one-line tagline, if any. */
  id?: string;
  name: string;
  url: string;
  /** Omit when the sponsor has no usable logo — a lettermark from `mark` is drawn instead. */
  logo?: string;
  /** Short lettermark (2–3 chars) for sponsors without a logo. */
  mark?: string;
  /** Logo needs a dark plate to stay visible on light surfaces. */
  darkPlate?: boolean;
};

export type SponsorTier = {
  id: SponsorTierId;
  listPrice: number;
  price: number;
  soldOut: boolean;
  holders: SponsorHolder[];
};

export const SPONSOR_TIERS: SponsorTier[] = [
  {
    id: "title",
    listPrice: 400,
    price: 200,
    soldOut: true,
    holders: [{ name: SPONSOR.name, url: SPONSOR.url, logo: SPONSOR.logo }],
  },
  {
    id: "model",
    listPrice: 300,
    price: 150,
    soldOut: true,
    holders: [{ name: "StepFun", url: "https://www.stepfun.com/", logo: "/stepfun.svg", darkPlate: true }],
  },
  {
    id: "featured",
    listPrice: 60,
    price: 35,
    soldOut: false,
    // The project's own logo is built on DeepSeek's whale mark; a lettermark
    // keeps the homepage from reading as a DeepSeek sponsorship.
    holders: [
      { id: "dsh", name: "ds-harness-remote", url: "https://github.com/liguobao/ds-harness-remote", mark: "DSH" },
      { id: "mosoo", name: "mosoo", url: "https://mosoo.ai", logo: "/mosoo.svg" },
      { id: "phi", name: "Phi Browser", url: "https://phibrowser.com/?utm_source=ghfind&utm_medium=sponsor", logo: "/phibrowser.png" },
    ],
  },
  { id: "friend", listPrice: 30, price: 25, soldOut: false, holders: [] },
];

/** Slots in the homepage sponsor row; unfilled ones advertise the tier. */
export const HOME_SPONSOR_SLOTS = 4;

/** Friend sponsors thanked (with an outbound link) on the sponsor page. */
export const FRIEND_SPONSORS: SponsorHolder[] = [];

export const SPONSOR_CONTACT_EMAIL = "lbm21@tsinghua.org.cn";
