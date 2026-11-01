import { ImageResponse } from "next/og";
import { CDN_CACHE, fonts } from "../../card/shared";

export const runtime = "nodejs";
export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * Homepage OG card (1200x630). Static — the site's default social/preview image,
 * referenced from the root metadata. Latin-only Inter (shared with the other
 * cards), so the copy stays English.
 */
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0a0a0b",
          padding: "72px 80px",
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 16, height: 16, borderRadius: 8, background: "#ea580c" }} />
          <div style={{ fontSize: 30, fontWeight: 800, color: "#fafafa" }}>ghfind</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 60,
              fontWeight: 800,
              lineHeight: 1.1,
              color: "#fafafa",
              letterSpacing: "-0.02em",
            }}
          >
            Score any GitHub account 0–100
          </div>
          <div style={{ marginTop: 20, fontSize: 32, color: "#a1a1aa", lineHeight: 1.3 }}>
            Real contribution value & trust, deterministically. Plus a witty roast.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid #27272a",
            paddingTop: 28,
          }}
        >
          <div style={{ fontSize: 26, color: "#71717a" }}>Open-source scoring engine</div>
          <div style={{ fontSize: 26, color: "#ea580c" }}>ghfind.com</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, fonts: await fonts(), headers: { "Cache-Control": CDN_CACHE } },
  );
}
