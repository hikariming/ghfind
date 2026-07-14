/**
 * Shared scaffolding for the OG card routes (`/api/card/[username]` and
 * `/api/card/vs/[a]/[b]`): font loading, avatar prefetch, QR generation, and the
 * ImageResponse wrapper. Kept in one place so both routes stay consistent (same
 * fonts, same long CDN cache) instead of copying the boilerplate.
 */
import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";
import QRCode from "qrcode";
import { SITE_URL } from "@/lib/site";
import { H, W } from "./[username]/cards";

/** Long edge cache: README/social scrapers hit the CDN, not the function. */
export const CDN_CACHE =
  "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";

type FontList = { name: string; data: Buffer; weight: 400 | 800; style: "normal" }[];

// Module-cache the (tiny, ~30KB each) Latin fonts across warm invocations.
let fontCache: FontList | null = null;
export async function fonts(): Promise<FontList> {
  if (fontCache) return fontCache;
  const [regular, bold] = await Promise.all([
    readFile(new URL("./fonts/Inter-Regular.woff", import.meta.url)),
    readFile(new URL("./fonts/Inter-ExtraBold.woff", import.meta.url)),
  ]);
  fontCache = [
    { name: "Inter", data: regular, weight: 400, style: "normal" },
    { name: "Inter", data: bold, weight: 800, style: "normal" },
  ];
  return fontCache;
}

/** Pre-fetch an avatar to a data URL so a flaky fetch can't break rendering. */
export async function avatarDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
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

/** Render an OG element to a 1200×630 PNG with the shared fonts + cache header. */
export function png(element: React.ReactElement, fontList: FontList) {
  return new ImageResponse(element, {
    width: W,
    height: H,
    fonts: fontList,
    emoji: "twemoji",
    headers: { "Cache-Control": CDN_CACHE },
  });
}
