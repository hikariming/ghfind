import { ImageResponse } from "next/og";
import { getPaper } from "@/lib/db";
import { normalizeArxivId } from "@/lib/arxiv";
import { SPONSOR } from "@/lib/sponsor";
import { SITE_URL } from "@/lib/site";
import type { PaperTierKey } from "@/lib/paper-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CDN_CACHE = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";
const W = 1200;
const H = 630;
const BG = "#0a0a0b";

const TIER_HEX: Record<PaperTierKey, string> = {
  masterpiece: "#fcd34d",
  strong: "#c4b5fd",
  solid: "#6ee7b7",
  mediocre: "#cbd5e1",
  water: "#fb7185",
};
const TIER_EMOJI: Record<PaperTierKey, string> = {
  masterpiece: "🏆",
  strong: "🥇",
  solid: "📘",
  mediocre: "🫥",
  water: "💧",
};
const TIER_EN: Record<PaperTierKey, string> = {
  masterpiece: "Masterpiece",
  strong: "Top-tier",
  solid: "Readable",
  mediocre: "Mediocre",
  water: "Filler",
};

function Shell({ glow, children }: { glow: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        width: W,
        height: H,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 56,
        backgroundColor: BG,
        backgroundImage: `radial-gradient(900px circle at 95% -10%, ${glow}, transparent 60%)`,
        color: "#fff",
      }}
    >
      {children}
    </div>
  );
}

function Brand() {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22 }}>
      <div style={{ display: "flex", color: "#71717a" }}>
        arXiv Roast ·{" "}
        <span style={{ color: "#fb923c", fontWeight: 800, marginLeft: 6 }}>{SITE_URL.replace(/^https?:\/\//, "")}</span>
      </div>
      <div style={{ display: "flex", color: "#71717a" }}>Powered by {SPONSOR.name}</div>
    </div>
  );
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const arxivId = normalizeArxivId(decodeURIComponent(id ?? ""));
  const paper = arxivId ? await getPaper(arxivId) : null;

  if (!paper) {
    return new ImageResponse(
      (
        <Shell glow="rgba(148,163,184,0.25)">
          <div style={{ display: "flex", fontSize: 30, fontWeight: 800, color: "#a1a1aa" }}>
            arXiv Roast
          </div>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 800, color: "#a1a1aa" }}>
            Not yet reviewed
          </div>
          <Brand />
        </Shell>
      ),
      { width: W, height: H, headers: { "Cache-Control": CDN_CACHE } },
    );
  }

  const color = TIER_HEX[paper.tier];
  const title = paper.title.length > 150 ? `${paper.title.slice(0, 150)}…` : paper.title;

  return new ImageResponse(
    (
      <Shell glow={`${color}55`}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 22, color: "#71717a", marginBottom: 14 }}>
            arXiv:{paper.arxiv_id}
          </div>
          <div style={{ display: "flex", fontSize: 44, fontWeight: 800, lineHeight: 1.18 }}>
            {title}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <span style={{ fontSize: 120, fontWeight: 800, color, lineHeight: 1 }}>
              {paper.final_score.toFixed(1)}
            </span>
            <span style={{ fontSize: 40, color: "#52525b", marginLeft: 8, marginBottom: 12 }}>/100</span>
          </div>
          <div style={{ display: "flex", fontSize: 46, fontWeight: 800, color }}>
            {TIER_EMOJI[paper.tier]} {TIER_EN[paper.tier]}
          </div>
        </div>
        <Brand />
      </Shell>
    ),
    { width: W, height: H, emoji: "twemoji", headers: { "Cache-Control": CDN_CACHE } },
  );
}
