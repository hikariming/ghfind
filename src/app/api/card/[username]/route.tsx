import { getGoProfileCardPresentation } from "@/lib/go-profile.server";
import { BADGE_COLOR, TIER_EN, TIER_LABEL_EN } from "@/lib/badge";
import { adventurerLevel, realmForScore, type RealmDef } from "@/lib/realm";
import { getCurrentTitleSponsor } from "@/lib/sponsor.server";
import { USERNAME_RE } from "@/lib/username";
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
import { decodeRouteParam } from "@/lib/route-params";


function parseCardLang(req: Request): "zh" | "en" {
  const lang = new URL(req.url).searchParams.get("lang");
  return lang === "zh" ? "zh" : "en";
}

/** Inline SVG realm mark for Satori — glyph only next to the realm label. */
function OgRealmGlyph({ realm, color, size = 34 }: { realm: RealmDef; color: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    style: { marginRight: 10, flexShrink: 0 },
  } as const;
  if (realm.glyph === "dot") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3.2" fill={color} />
      </svg>
    );
  }
  if (realm.glyph === "core") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5" fill="none" stroke={color} strokeWidth="1.4" />
        <circle cx="8" cy="8" r="2.4" fill={color} />
      </svg>
    );
  }
  if (realm.glyph === "lotus") {
    return (
      <svg {...common}>
        <ellipse cx="8" cy="4.2" rx="2.1" ry="3.2" fill={color} />
        <ellipse cx="8" cy="11.8" rx="2.1" ry="3.2" fill={color} />
        <ellipse cx="4.2" cy="8" rx="3.2" ry="2.1" fill={color} />
        <ellipse cx="11.8" cy="8" rx="3.2" ry="2.1" fill={color} />
        <circle cx="8" cy="8" r="1.6" fill={color} />
      </svg>
    );
  }
  const star: string[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI / 8) * i - Math.PI / 2;
    const r = i % 2 === 0 ? 7 : 3.1;
    star.push(`${(8 + Math.cos(a) * r).toFixed(2)},${(8 + Math.sin(a) * r).toFixed(2)}`);
  }
  return (
    <svg {...common}>
      <polygon points={star.join(" ")} fill={color} />
    </svg>
  );
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ username: string }> }) {
  const fontList = await fonts();
  const theme = parseTheme(req);
  const lang = parseCardLang(req);
  const palette = PALETTES[theme];
  const { username } = await ctx.params;
  const name = decodeRouteParam(username ?? "").trim();

  // Satori rasterizes this away, so the full-size mark costs the response nothing.
  const titleSponsor = await getCurrentTitleSponsor();
  const presentation = USERNAME_RE.test(name) ? await getGoProfileCardPresentation(name) : null;
  const detail = presentation?.detail ?? null;

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
        <Brand palette={palette} sponsorLogo={titleSponsor?.logo} sponsorName={titleSponsor?.name} />
      </Shell>,
      fontList,
    );
  }

  const tier = detail.tier as Tier;
  const realm = realmForScore(detail.final_score);
  const color = realm.colors.fg;
  const beat = presentation?.percentile?.beat ?? null;
  // Weekly movement — the embed changes week to week, so a card pasted into a
  // README keeps pulling its owner (and their visitors) back.
  const delta = presentation?.delta ?? null;
  const avatar = await avatarDataUrl(detail.avatar_url);
  const displayName =
    detail.display_name && /^[\x20-\x7e]+$/.test(detail.display_name) ? detail.display_name : null;
  const tags = ((lang === "zh" ? detail.tags.zh : detail.tags.en) ?? detail.tags.en ?? []).slice(0, 4);

  const qr = parseQr(req)
    ? await qrDataUrl(`/u/${detail.username}?ref=badge`, qrModuleColor(color, theme))
    : null;
  const id: Identity = {
    username: detail.username,
    displayName,
    avatar,
    tier,
    score: detail.final_score,
    lang,
    color,
    palette,
    qr,
    sponsorLogo: titleSponsor?.logo ?? null,
    sponsorName: titleSponsor?.name ?? null,
  };

  // Specialty "brag cards" read the sedimented profile snapshot. If it's missing
  // or lacks the data this card needs (low-tier accounts are never backfilled),
  // fall through to the always-available score card so an embed never breaks.
  const variant = parseVariant(req);
  if (variant !== "score") {
    const snap = presentation?.snapshot ?? null;
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
            color={color}
            palette={palette}
          />
        </div>
      </div>

      {/* Score → Adventurer Level */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "0.18em", color: palette.muted, textTransform: "uppercase" }}>
            {lang === "zh" ? "冒险者等级" : "Adventurer Level"}
          </span>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <span style={{ fontSize: 52, fontWeight: 800, color, lineHeight: 1, marginBottom: 14, opacity: 0.9 }}>
              Lv.
            </span>
            <span style={{ fontSize: 116, fontWeight: 800, color, lineHeight: 1 }} title={`Composite ${detail.final_score.toFixed(2)}`}>
              {adventurerLevel(detail.final_score)}
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
                ↑{delta.toFixed(1)} {lang === "zh" ? "本周" : "this week"}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", fontSize: 40, fontWeight: 800, color, marginTop: 8 }}>
            <OgRealmGlyph realm={realm} color={color} />
            {lang === "zh" ? realm.nameZh : realm.nameEn}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: palette.muted, marginTop: 2 }}>
            {lang === "zh" ? realm.blurbZh : realm.blurbEn}
          </div>
        </div>
        {beat !== null && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span style={{ fontSize: 64, fontWeight: 800, color }}>{beat.toFixed(1)}%</span>
            <span style={{ fontSize: 22, color: palette.muted }}>
              {lang === "zh" ? "超越的开发者" : "ahead of devs"}
            </span>
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

      <Brand palette={palette} sponsorLogo={titleSponsor?.logo} sponsorName={titleSponsor?.name} />
    </Shell>,
    fontList,
  );
}
