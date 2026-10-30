/**
 * Card helpers that do not depend on the PNG renderer: cache policy, avatar
 * and QR data URLs. The SVG card routes (mini card, material card) import
 * these directly so they never pull `next/og` (and its WASM) into a bundle —
 * notably the Hono API Worker, which serves those routes.
 */
import QRCode from "qrcode";
import { SITE_URL } from "@/lib/site";

/** Long edge cache for content that never changes per user (OG home/blog). */
export const CDN_CACHE =
  "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";

/**
 * Edge cache for anything that renders a user's score (cards, badges): a
 * rescan or score-version bump must show up within minutes, not the 6h+24h
 * of {@link CDN_CACHE}. The router isolate cache and the API Workers Cache
 * both honor s-maxage / stale-while-revalidate, so this bounds staleness at
 * every edge layer. `max-age=0` keeps browsers and GitHub camo revalidating;
 * never `immutable`. The on-page previews add `?v=<scanned_at>`, which the
 * router keeps in the cache key, so they refresh immediately after a rescan.
 */
export const SCORE_CARD_CACHE =
  "public, max-age=0, s-maxage=600, stale-while-revalidate=3600";

/**
 * Pre-fetch an avatar to a data URL so a flaky fetch can't break rendering.
 *
 * `size` asks GitHub for a downscaled avatar (`?s=`). The SVG cards inline the
 * bytes as base64 into every response, so a 96px avatar (~5KB) instead of the
 * default (~40KB) is most of the payload on those endpoints.
 */
export async function avatarDataUrl(
  url: string | null,
  size?: number,
): Promise<string | null> {
  if (!url) return null;
  try {
    const src = size ? `${url}${url.includes("?") ? "&" : "?"}s=${size}` : url;
    const res = await fetch(src);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Tier-tinted QR module color that stays scannable on either theme. */
export function qrModuleColor(hex: string, mode: "dark" | "light"): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return mode === "dark" ? "#ffffff" : "#000000";
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const target = mode === "dark" ? 255 : 0;
  const f = mode === "dark" ? 0.55 : 0.3;
  const out = ch.map((c) => Math.round(c * (1 - f) + target * f));
  return `#${((1 << 24) | (out[0] << 16) | (out[1] << 8) | out[2]).toString(16).slice(1)}`;
}

/** QR (PNG data URL) of a site path (`/u/x`, `/vs/a/b`) with a transparent bg. */
export async function qrDataUrl(path: string, dark: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(`${SITE_URL}${path}`, {
      margin: 1,
      width: 300,
      // The rendered card places the ghfind mark over the center modules. High
      // correction keeps the code robust after that intentional occlusion.
      errorCorrectionLevel: "H",
      color: { dark, light: "#00000000" },
    });
  } catch {
    return null;
  }
}
