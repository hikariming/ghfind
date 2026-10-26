/**
 * Shared scaffolding for the OG card routes (`/api/card/[username]` and
 * `/api/card/vs/[a]/[b]`): font loading, avatar prefetch, QR generation, and the
 * ImageResponse wrapper. Kept in one place so both routes stay consistent (same
 * fonts, same score-card CDN cache) instead of copying the boilerplate.
 */
import { ImageResponse } from "next/og";
import assets from "@/generated/embedded-assets.json";
import { H, W } from "./[username]/cards";
import { SCORE_CARD_CACHE } from "./assets";

export { avatarDataUrl, CDN_CACHE, qrDataUrl, qrModuleColor, SCORE_CARD_CACHE } from "./assets";

type FontList = { name: string; data: Buffer; weight: 400 | 800; style: "normal" }[];

// The (tiny, ~30KB each) Latin fonts ship base64-embedded in the bundle —
// runtimes without a filesystem (Workers) can't read the .woff files.
// Module-cache the decoded buffers across warm invocations.
let fontCache: FontList | null = null;
export async function fonts(): Promise<FontList> {
  if (fontCache) return fontCache;
  fontCache = [
    { name: "Inter", data: Buffer.from(assets.fonts.interRegular, "base64"), weight: 400, style: "normal" },
    { name: "Inter", data: Buffer.from(assets.fonts.interExtraBold, "base64"), weight: 800, style: "normal" },
  ];
  return fontCache;
}

/** Render an OG element to a 1200×630 PNG with the shared fonts + score-card cache header. */
export function png(element: React.ReactElement, fontList: FontList) {
  return new ImageResponse(element, {
    width: W,
    height: H,
    fonts: fontList,
    emoji: "twemoji",
    headers: { "Cache-Control": SCORE_CARD_CACHE },
  });
}
