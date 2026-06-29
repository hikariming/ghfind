import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";
import { getAccountDetail, getPercentile } from "@/lib/db";
import { BADGE_COLOR, TIER_EN, TIER_LABEL_EN } from "@/lib/badge";
import { beatPercent } from "@/lib/percentile";
import { SPONSOR } from "@/lib/sponsor";
import { tierAvatarFrame } from "@/lib/tier";
import type { TierAvatarFramePlacement } from "@/lib/tier";
import type { Tier } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

// Long edge cache: GitHub README views are served by the CDN (and camo) — the
// PNG is generated at most ~once per window per account. Keeps the bill flat.
const CDN_CACHE = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";

const W = 1200;
const H = 630;

type CardTheme = "dark" | "light";

const DARK_BG = "#0a0a0b";

interface CardPalette {
  mode: CardTheme;
  bg: string;
  fg: string;
  muted: string;
  subtle: string;
  weak: string;
  handleBg: string;
  avatarBg: string;
  avatarBorder: string;
  emojiBg: string;
  tagBg: string;
  tagBorder: string;
  tagText: string;
}

const PALETTES: Record<CardTheme, CardPalette> = {
  dark: {
    mode: "dark",
    bg: DARK_BG,
    fg: "#ffffff",
    muted: "#a1a1aa",
    subtle: "#71717a",
    weak: "#52525b",
    handleBg: "rgba(0,0,0,0.35)",
    avatarBg: "#27272a",
    avatarBorder: "#050505",
    emojiBg: DARK_BG,
    tagBg: "rgba(249,115,22,0.10)",
    tagBorder: "rgba(251,146,60,0.30)",
    tagText: "#fed7aa",
  },
  light: {
    mode: "light",
    bg: "#f6f8fb",
    fg: "#18181b",
    muted: "#52525b",
    subtle: "#737373",
    weak: "#52525b",
    handleBg: "rgba(255,255,255,0.86)",
    avatarBg: "#e5e7eb",
    avatarBorder: "#ffffff",
    emojiBg: "#ffffff",
    tagBg: "rgba(249,115,22,0.10)",
    tagBorder: "rgba(234,88,12,0.24)",
    tagText: "#c2410c",
  },
};

function parseTheme(req: Request): CardTheme {
  const raw = new URL(req.url).searchParams.get("theme");
  return raw === "light" ? "light" : "dark";
}

// Module-cache the (tiny, ~30KB each) Latin fonts across warm invocations.
let fontCache: { name: string; data: Buffer; weight: 400 | 800; style: "normal" }[] | null = null;
async function fonts() {
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

/** Pre-fetch the avatar to a data URL so a flaky fetch can't break rendering. */
async function avatarDataUrl(url: string | null): Promise<string | null> {
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

function png(element: React.ReactElement, fontList: Awaited<ReturnType<typeof fonts>>) {
  return new ImageResponse(element, {
    width: W,
    height: H,
    fonts: fontList,
    emoji: "twemoji",
    headers: { "Cache-Control": CDN_CACHE },
  });
}

function Shell({
  glow,
  palette,
  children,
}: {
  glow: string;
  palette: CardPalette;
  children: React.ReactNode;
}) {
  const backgroundImage =
    palette.mode === "light"
      ? `radial-gradient(800px circle at 94% -10%, ${glow}, transparent 58%), linear-gradient(180deg, #ffffff 0%, ${palette.bg} 74%)`
      : `radial-gradient(900px circle at 95% -10%, ${glow}, transparent 60%)`;
  return (
    <div
      style={{
        width: W,
        height: H,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 52,
        backgroundColor: palette.bg,
        backgroundImage,
        color: palette.fg,
        fontFamily: "Inter",
      }}
    >
      {children}
    </div>
  );
}

function Brand({ palette }: { palette: CardPalette }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22 }}>
      <div style={{ display: "flex", color: palette.subtle }}>
        GitHub Roast ·{" "}
        <span style={{ color: "#fb923c", fontWeight: 800, marginLeft: 6 }}>githubroast.dev</span>
      </div>
      <div style={{ display: "flex", color: palette.subtle }}>Powered by {SPONSOR.name}</div>
    </div>
  );
}

function OgAvatarFrame({
  username,
  avatar,
  tier,
  color,
  palette,
}: {
  username: string;
  avatar: string | null;
  tier: Tier;
  color: string;
  palette: CardPalette;
}) {
  const frame = tierAvatarFrame(tier);
  const emojiBox = frame.emojiSize === "large" ? 48 : 34;
  const emojiFont = frame.emojiSize === "large" ? 32 : 22;
  const center = (152 - emojiBox) / 2;
  const side = -emojiBox / 2;
  const corner = frame.emojiSize === "large" ? 0 : 6;
  const positions: Record<TierAvatarFramePlacement, React.CSSProperties> = {
    top: { left: center, top: side },
    "top-right": { right: corner, top: corner },
    right: { right: side, top: center },
    "bottom-right": { right: corner, bottom: corner },
    bottom: { left: center, bottom: side },
    "bottom-left": { left: corner, bottom: corner },
    left: { left: side, top: center },
    "top-left": { left: corner, top: corner },
  };

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        width: 152,
        height: 152,
        borderRadius: 9999,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: `${color}1A`,
        boxShadow: `0 0 44px -12px ${color}`,
        border: `3px solid ${color}B3`,
      }}
    >
      {frame.placements.map((placement) => (
        <div
          key={`${frame.emoji}-${placement}`}
          style={{
            position: "absolute",
            display: "flex",
            width: emojiBox,
            height: emojiBox,
            borderRadius: 9999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: palette.emojiBg,
            fontSize: emojiFont,
            lineHeight: 1,
            ...positions[placement],
          }}
        >
          {frame.emoji}
        </div>
      ))}
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatar}
          width={112}
          height={112}
          style={{ borderRadius: 9999, border: `4px solid ${palette.avatarBorder}` }}
          alt=""
        />
      ) : (
        <div
          style={{
            display: "flex",
            width: 112,
            height: 112,
            borderRadius: 9999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: palette.avatarBg,
            border: `4px solid ${palette.avatarBorder}`,
            color: palette.fg,
            fontSize: 52,
            fontWeight: 800,
          }}
        >
          {username.slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ username: string }> }) {
  const fontList = await fonts();
  const theme = parseTheme(req);
  const palette = PALETTES[theme];
  const { username } = await ctx.params;
  const name = decodeURIComponent(username ?? "").trim();

  const detail = USERNAME_RE.test(name) ? await getAccountDetail(name) : null;

  // Unrated placeholder — keeps READMEs from showing a broken image.
  if (!detail) {
    return png(
      <Shell glow="rgba(148,163,184,0.25)" palette={palette}>
        <div style={{ display: "flex", fontSize: 34, fontWeight: 800 }}>
          @{name || "unknown"}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 64, fontWeight: 800, color: palette.muted }}>
            Not yet rated
          </div>
          <div style={{ display: "flex", fontSize: 26, color: palette.subtle, marginTop: 8 }}>
            Get roasted at githubroast.dev
          </div>
        </div>
        <Brand palette={palette} />
      </Shell>,
      fontList,
    );
  }

  const tier = detail.tier as Tier;
  const color = BADGE_COLOR[tier];
  const counts = await getPercentile(detail.final_score);
  const beat = counts ? beatPercent(counts.below, counts.total) : null;
  const avatar = await avatarDataUrl(detail.avatar_url);
  const displayName =
    detail.display_name && /^[\x20-\x7e]+$/.test(detail.display_name) ? detail.display_name : null;
  const tags = (detail.tags.en ?? []).slice(0, 4);

  return png(
    <Shell glow={`${color}${theme === "light" ? "30" : "55"}`} palette={palette}>
      {/* Header */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            borderRadius: 9999,
            backgroundColor: palette.handleBg,
            border: `2px solid ${color}80`,
            boxShadow: `0 0 34px -12px ${color}`,
            color,
            fontSize: 38,
            fontWeight: 800,
            padding: "8px 26px",
          }}
        >
          @{detail.username}
        </div>
        {displayName && (
          <div style={{ display: "flex", marginTop: 8, fontSize: 22, color: palette.muted }}>
            {displayName}
          </div>
        )}
        <div style={{ display: "flex", marginTop: 18 }}>
          <OgAvatarFrame
            username={detail.username}
            avatar={avatar}
            tier={tier}
            color={color}
            palette={palette}
          />
        </div>
      </div>

      {/* Score */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <span style={{ fontSize: 116, fontWeight: 800, color, lineHeight: 1 }}>
              {detail.final_score.toFixed(2)}
            </span>
            <span style={{ fontSize: 40, color: palette.weak, marginLeft: 8, marginBottom: 10 }}>
              /100
            </span>
          </div>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 800, color, marginTop: 8 }}>
            {TIER_EN[tier]}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: palette.muted, marginTop: 2 }}>
            {TIER_LABEL_EN[tier]}
          </div>
        </div>
        {beat !== null && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span style={{ fontSize: 64, fontWeight: 800, color }}>{beat.toFixed(1)}%</span>
            <span style={{ fontSize: 22, color: palette.muted }}>ahead of devs</span>
          </div>
        )}
      </div>

      {/* Tags */}
      {tags.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap" }}>
          {tags.map((t) => (
            <div
              key={t}
              style={{
                display: "flex",
                marginRight: 12,
                marginTop: 8,
                padding: "6px 18px",
                borderRadius: 9999,
                border: `1px solid ${palette.tagBorder}`,
                backgroundColor: palette.tagBg,
                color: palette.tagText,
                fontSize: 24,
                fontWeight: 800,
              }}
            >
              #{t}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex" }} />
      )}

      <Brand palette={palette} />
    </Shell>,
    fontList,
  );
}
