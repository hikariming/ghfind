/**
 * The sponsor logo as a data URL, for the server-rendered cards.
 *
 * Every card is generated on the server and then travels alone: an SVG inside an
 * `<img>` may not fetch anything, and a Satori PNG is rasterized before it
 * leaves. So the logo bytes have to be inlined rather than linked.
 *
 * Pick `small` for the SVG cards (inlined into every response, drawn ~13px) and
 * `full` for the PNG/print surfaces, where the bytes are rasterized away or the
 * card is an export asset.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { SPONSOR } from "./sponsor";

const dataUrls = new Map<string, Promise<string | null>>();

export function sponsorLogoDataUrl(size: "small" | "full" = "full"): Promise<string | null> {
  const file = size === "small" ? SPONSOR.logoSmall : SPONSOR.logo;
  const cached = dataUrls.get(file);
  if (cached) return cached;

  // Resolves to null rather than rejecting: a missing sponsor asset is worth a
  // credit line without its logo, never a card that fails to render.
  const dataUrl = readFile(path.join(process.cwd(), "public", file))
    .then((buf) => `data:image/png;base64,${buf.toString("base64")}`)
    .catch(() => null);
  dataUrls.set(file, dataUrl);
  return dataUrl;
}
