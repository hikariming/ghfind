/**
 * The title sponsor credited on every server-rendered card.
 *
 * The title slot is a fixed, long-term placement, so it is a constant rather
 * than a D1 lookup: a card embedded in someone's README must never depend on a
 * database query (or a pending migration) just to draw a credit line. The
 * sponsor page and homepage rows still read the `sponsorships` table.
 *
 * Every card travels alone — an SVG inside an `<img>` may not fetch anything,
 * and a Satori PNG is rasterized before it leaves — so the logo bytes are
 * inlined from the bundle (scripts/gen-embedded-assets.mts). A missing asset
 * resolves to null: a credit line without its logo, never a broken card.
 *
 * Pick `small` for the SVG cards (inlined into every response, drawn ~13px) and
 * `full` for the PNG/print surfaces.
 */

import assets from "@/generated/embedded-assets.json";

export interface CurrentTitleSponsor {
  name: string;
  url: string | null;
  description: string | null;
  logo: string | null;
}

const TITLE_SPONSOR = {
  name: "LobeHub",
  url: "https://lobehub.com",
  description: "Your Chief Agent Operator · 你的首席 Agent 操作官",
  logo: "/lobehub.png",
  /** 32px re-encode of the same mark, so SVG cards don't inline the 192px original. */
  logoSmall: "/lobehub-32.png",
};

export function getCurrentTitleSponsor(
  size: "small" | "full" = "full",
): Promise<CurrentTitleSponsor | null> {
  const embedded = assets.sponsor as Record<string, string>;
  const logo = size === "small"
    ? embedded[TITLE_SPONSOR.logoSmall] ?? embedded[TITLE_SPONSOR.logo] ?? null
    : embedded[TITLE_SPONSOR.logo] ?? null;

  return Promise.resolve({
    name: TITLE_SPONSOR.name,
    url: TITLE_SPONSOR.url,
    description: TITLE_SPONSOR.description,
    logo,
  });
}
