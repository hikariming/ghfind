import {
  getAccountDetail,
  getProfileSnapshot,
  getWeeklyBaselines,
  resolveWeeklyDelta,
} from "@/lib/db";
import { getPercentileCached } from "@/lib/rank";
import { BADGE_COLOR, TIER_EN, TIER_LABEL_EN } from "@/lib/badge";
import { beatPercent } from "@/lib/percentile";
import { USERNAME_RE } from "@/lib/username";
import { tierAvatarFrame } from "@/lib/tier";
import { tierAvatarFrameIconDataUrl } from "@/lib/tier-emoji.server";
import type { Tier } from "@/lib/types";
import {
  Brand,
  OgAvatarFrame,
  PALETTES,
  Shell,
  parseQr,
  parseTheme,
  parseVariant,
  renderVariant,
  variantHasData,
} from "./cards";
import type { Identity } from "./cards";
import { avatarDataUrl, fonts, png, qrDataUrl, qrModuleColor } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
            Get roasted at ghfind.com
          </div>
        </div>
        <Brand palette={palette} />
      </Shell>,
      fontList,
    );
  }

  const tier = detail.tier as Tier;
  const color = BADGE_COLOR[tier];
  const counts = await getPercentileCached(detail.final_score);
  const beat = counts ? beatPercent(counts.below, counts.total) : null;
  // Weekly movement — the embed changes week to week, so a card pasted into a
  // README keeps pulling its owner (and their visitors) back.
  const baselines = await getWeeklyBaselines([detail.username]);
  const delta = resolveWeeklyDelta({
    currentScore: detail.final_score,
    snapshotBaseline: baselines.get(detail.username) ?? null,
    prevScore: detail.prev_score,
    prevScannedAt: detail.prev_scanned_at,
  });
  const [avatar, tierIcon] = await Promise.all([
    avatarDataUrl(detail.avatar_url),
    tierAvatarFrameIconDataUrl(tierAvatarFrame(tier).icon),
  ]);
  const displayName =
    detail.display_name && /^[\x20-\x7e]+$/.test(detail.display_name) ? detail.display_name : null;
  const tags = (detail.tags.en ?? []).slice(0, 4);

  const qr = parseQr(req)
    ? await qrDataUrl(`/u/${detail.username}?ref=badge`, qrModuleColor(color, theme))
    : null;
  const id: Identity = {
    username: detail.username,
    displayName,
    avatar,
    tier,
    tierIcon,
    color,
    palette,
    qr,
  };

  // Specialty "brag cards" read the sedimented profile snapshot. If it's missing
  // or lacks the data this card needs (low-tier accounts are never backfilled),
  // fall through to the always-available score card so an embed never breaks.
  const variant = parseVariant(req);
  if (variant !== "score") {
    const snap = await getProfileSnapshot(detail.username);
    if (variantHasData(variant, snap) && snap) {
      return png(renderVariant(variant, id, snap), fontList);
    }
  }

  return png(
    <Shell glow={`${color}${theme === "light" ? "30" : "55"}`} palette={palette} qr={qr}>
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
            tierIcon={tierIcon}
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
            {/* Brag surface: only upward movement is shown — a public README
                embed must never broadcast its owner's decline. */}
            {delta !== null && delta > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  marginLeft: 18,
                  marginBottom: 14,
                  padding: "6px 16px",
                  borderRadius: 9999,
                  backgroundColor: "rgba(34,197,94,0.16)",
                  color: "#22C55E",
                  fontSize: 26,
                  fontWeight: 800,
                }}
              >
                ↑{delta.toFixed(1)} this week
              </div>
            )}
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
