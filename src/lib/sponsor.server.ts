/**
 * The sponsor logo as a data URL, for the server-rendered cards.
 *
 * Every card is generated on the server and then travels alone: an SVG inside an
 * `<img>` may not fetch anything, and a Satori PNG is rasterized before it
 * leaves. So the logo bytes have to be inlined rather than linked.
 *
 * The bytes ship base64-embedded in the bundle (scripts/gen-embedded-assets.mts)
 * — no runtime filesystem on Workers. A missing sponsor asset resolves to null
 * rather than failing: a credit line without its logo, never a broken card.
 *
 * Pick `small` for the SVG cards (inlined into every response, drawn ~13px) and
 * `full` for the PNG/print surfaces, where the bytes are rasterized away or the
 * card is an export asset.
 */

import assets from "@/generated/embedded-assets.json";
import { SPONSOR } from "./sponsor";

export function sponsorLogoDataUrl(size: "small" | "full" = "full"): Promise<string | null> {
  const file = size === "small" ? SPONSOR.logoSmall : SPONSOR.logo;
  return Promise.resolve((assets.sponsor as Record<string, string>)[file] ?? null);
}
