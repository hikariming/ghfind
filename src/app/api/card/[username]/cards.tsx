/**
 * Presentational layer for the profile cards (`/api/card/{username}`).
 *
 * Split out of `route.tsx` so the Satori/`ImageResponse` JSX is importable by a
 * render test (route files may only export HTTP handlers + config). Everything
 * here is a pure component or helper — no DB / request access.
 */
import type { ProfileSnapshotView } from "@/lib/db";
import { TIER_EN } from "@/lib/badge";
import { rankProfileWorks } from "@/lib/profile-work";
import { SPONSOR } from "@/lib/sponsor";
import { TIER_AVATAR_FRAME_VECTORS, tierAvatarFrame } from "@/lib/tier";
import type { TierAvatarFramePlacement } from "@/lib/tier";
import type { Tier } from "@/lib/types";
import { BrandMark } from "@/components/BrandMark";

export const W = 1200;
export const H = 630;

export type CardTheme = "dark" | "light";

const DARK_BG = "#0a0a0b";

export interface CardPalette {
  mode: CardTheme;
  bg: string;
  fg: string;
  muted: string;
  subtle: string;
  weak: string;
  handleBg: string;
  avatarBg: string;
  avatarBorder: string;
  tagBg: string;
  tagBorder: string;
  tagText: string;
}

export const PALETTES: Record<CardTheme, CardPalette> = {
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
    tagBg: "rgba(249,115,22,0.10)",
    tagBorder: "rgba(234,88,12,0.24)",
    tagText: "#c2410c",
  },
};

export function parseTheme(req: Request): CardTheme {
  const raw = new URL(req.url).searchParams.get("theme");
  return raw === "light" ? "light" : "dark";
}

// `score` is the classic tier card (default). The rest are the specialty "brag
// cards": what you contributed to, PR track record, GitHub lifetime, own work.
export type CardVariant = "score" | "contrib" | "pr" | "path" | "work";
const VARIANTS = new Set<CardVariant>(["score", "contrib", "pr", "path", "work"]);

export function parseVariant(req: Request): CardVariant {
  const raw = new URL(req.url).searchParams.get("variant");
  return raw && VARIANTS.has(raw as CardVariant) ? (raw as CardVariant) : "score";
}

export function parseQr(req: Request): boolean {
  const raw = new URL(req.url).searchParams.get("qr");
  return raw === "1" || raw === "true";
}

/** 180000 → "180k", 2900 → "2.9k", 12 → "12". Compact so list stats fit. */
function fmtNum(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

/** `owner/name` → `owner/name`, but trim an over-long owner so rows don't wrap. */
function repoLabel(repo: string): string {
  return repo.length <= 30 ? repo : `…${repo.slice(-29)}`;
}

type QrPlacement = "top-right" | "inline";

interface QrPanelProps {
  qr: string;
  palette: CardPalette;
  placement: QrPlacement;
}

/** Small scannable QR (of the profile URL). Profile cards float it in the
 * top-right corner so enabling it never changes the content width. The shared
 * versus card can opt into the legacy inline placement until its combatant
 * header has a dedicated overlay-safe corner. */
function QrPanel({ qr, palette, placement }: QrPanelProps) {
  const floating = placement === "top-right";
  const placementStyle: React.CSSProperties = floating
    ? {
        position: "absolute",
        top: 52,
        right: 52,
        alignItems: "flex-start",
        marginLeft: 0,
      }
    : {
        alignItems: "flex-end",
        marginLeft: 28,
      };
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexShrink: 0,
        width: 116,
        height: 116,
        ...placementStyle,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} width={116} height={116} alt="" />
      <div
        style={{
          position: "absolute",
          left: 44,
          top: 44,
          display: "flex",
          width: 28,
          height: 28,
          backgroundColor: palette.bg,
          color: palette.fg,
        }}
      >
        <BrandMark style={{ width: 28, height: 28 }} />
      </div>
    </div>
  );
}

export interface ShellProps {
  glow: string;
  palette: CardPalette;
  qr?: string | null;
  qrPlacement?: QrPlacement;
  children: React.ReactNode;
}

export function Shell({
  glow,
  palette,
  qr,
  qrPlacement = "top-right",
  children,
}: ShellProps) {
  const backgroundImage =
    palette.mode === "light"
      ? `radial-gradient(800px circle at 94% -10%, ${glow}, transparent 58%), linear-gradient(180deg, #ffffff 0%, ${palette.bg} 74%)`
      : `radial-gradient(900px circle at 95% -10%, ${glow}, transparent 60%)`;
  return (
    <div
      style={{
        width: W,
        height: H,
        position: "relative",
        display: "flex",
        flexDirection: "row",
        padding: 52,
        backgroundColor: palette.bg,
        backgroundImage,
        color: palette.fg,
        fontFamily: "Inter",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          flexGrow: 1,
          flexBasis: 0,
          minWidth: 0,
        }}
      >
        {children}
      </div>
      {qr ? <QrPanel qr={qr} palette={palette} placement={qrPlacement} /> : null}
    </div>
  );
}

export function Brand({ palette }: { palette: CardPalette }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22 }}>
      <div style={{ display: "flex", color: palette.subtle }}>
        GitHub Roast ·{" "}
        <span style={{ color: "#fb923c", fontWeight: 800, marginLeft: 6 }}>ghfind.com</span>
      </div>
      <div style={{ display: "flex", color: palette.subtle }}>Powered by {SPONSOR.name}</div>
    </div>
  );
}

function avatarFrameIconPosition(
  placement: TierAvatarFramePlacement,
  frameSize: number,
  iconBoxSize: number,
): React.CSSProperties {
  const vector = TIER_AVATAR_FRAME_VECTORS[placement];
  const radius = frameSize / 2;
  return {
    left: radius + vector.x * radius - iconBoxSize / 2,
    top: radius + vector.y * radius - iconBoxSize / 2,
  };
}

export function OgAvatarFrame({
  username,
  avatar,
  tier,
  tierIcon,
  color,
  palette,
}: {
  username: string;
  avatar: string | null;
  tier: Tier;
  tierIcon: string;
  color: string;
  palette: CardPalette;
}) {
  const frame = tierAvatarFrame(tier);
  const emojiBox = frame.emojiSize === "large" ? 48 : 34;
  const emojiFont = frame.emojiSize === "large" ? 32 : 22;

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
            fontSize: emojiFont,
            lineHeight: 1,
            ...avatarFrameIconPosition(placement, 152, emojiBox),
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={tierIcon} width={emojiFont} height={emojiFont} alt="" />
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

/** Shared identity for every card: who + tier styling + resolved avatar. */
export interface Identity {
  username: string;
  displayName: string | null;
  avatar: string | null;
  tier: Tier;
  /** Data-URL SVG without font side bearings. */
  tierIcon: string;
  color: string;
  palette: CardPalette;
  /** Data-URL QR of the profile page, or null when the QR toggle is off. */
  qr: string | null;
}

function glowFor(id: Identity): string {
  return `${id.color}${id.palette.mode === "light" ? "30" : "55"}`;
}

/** Row background/border for list rows + stat tiles, per theme. */
function rowSkin(palette: CardPalette) {
  return palette.mode === "light"
    ? { bg: "rgba(0,0,0,0.035)", border: "rgba(0,0,0,0.08)" }
    : { bg: "rgba(255,255,255,0.045)", border: "rgba(255,255,255,0.09)" };
}

/** Compact avatar (circle + colored ring + one tier emoji badge) for the
 * specialty cards, which need a smaller header than the centered score hero. */
function HeaderAvatar({ id, size = 96 }: { id: Identity; size?: number }) {
  const { username, avatar, tierIcon, color, palette } = id;
  const badge = Math.round(size * 0.36);
  const badgeVector = TIER_AVATAR_FRAME_VECTORS["bottom-right"];
  return (
    <div style={{ position: "relative", display: "flex", width: size, height: size }}>
      {avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatar}
          width={size}
          height={size}
          style={{ borderRadius: 9999, border: `3px solid ${color}B3` }}
          alt=""
        />
      ) : (
        <div
          style={{
            display: "flex",
            width: size,
            height: size,
            borderRadius: 9999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: palette.avatarBg,
            border: `3px solid ${color}B3`,
            color: palette.fg,
            fontSize: size * 0.42,
            fontWeight: 800,
          }}
        >
          {username.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: size / 2 + badgeVector.x * (size / 2) - badge / 2,
          top: size / 2 + badgeVector.y * (size / 2) - badge / 2,
          display: "flex",
          width: badge,
          height: badge,
          borderRadius: 9999,
          alignItems: "center",
          justifyContent: "center",
          fontSize: badge * 0.62,
          lineHeight: 1,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={tierIcon} width={badge * 0.62} height={badge * 0.62} alt="" />
      </div>
    </div>
  );
}

/** avatar + @handle + tier pill — the top strip on every specialty card. */
function VariantHeader({ id }: { id: Identity }) {
  const { palette, color, tier } = id;
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <HeaderAvatar id={id} />
      <div style={{ display: "flex", flexDirection: "column", marginLeft: 22 }}>
        <div style={{ display: "flex", fontSize: 46, fontWeight: 800, color }}>
          @{id.username}
        </div>
        {id.displayName && (
          <div style={{ display: "flex", fontSize: 24, color: palette.muted, marginTop: 2 }}>
            {id.displayName}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          marginLeft: "auto",
          marginRight: id.qr ? 144 : 0,
          borderRadius: 9999,
          border: `2px solid ${color}80`,
          backgroundColor: palette.handleBg,
          boxShadow: `0 0 30px -12px ${color}`,
          color,
          fontSize: 32,
          fontWeight: 800,
          padding: "6px 24px",
        }}
      >
        {TIER_EN[tier]}
      </div>
    </div>
  );
}

/** Title + subtitle block that opens a specialty card's body. */
function BodyTitle({
  title,
  subtitle,
  palette,
}: {
  title: string;
  subtitle?: string;
  palette: CardPalette;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", fontSize: 36, fontWeight: 800, color: palette.fg }}>
        {title}
      </div>
      {subtitle && (
        <div style={{ display: "flex", fontSize: 24, color: palette.muted, marginTop: 6 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

/** One left-label / right-stat row used by the contributor + work lists. */
function ListRow({
  left,
  right,
  palette,
}: {
  left: string;
  right: string;
  palette: CardPalette;
}) {
  const skin = rowSkin(palette);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 12,
        padding: "14px 24px",
        borderRadius: 16,
        backgroundColor: skin.bg,
        border: `1px solid ${skin.border}`,
      }}
    >
      <div style={{ display: "flex", fontSize: 30, fontWeight: 800, color: palette.fg }}>
        {left}
      </div>
      <div style={{ display: "flex", fontSize: 24, color: palette.muted }}>{right}</div>
    </div>
  );
}

/** #1 贡献足迹卡 — the open-source projects you've landed code in, by stars. */
function ContribCard({ id, snap }: { id: Identity; snap: ProfileSnapshotView }) {
  const { palette } = id;
  const repos = [...snap.impact_repos].sort((a, b) => b.stars - a.stars).slice(0, 4);
  const count = snap.metrics.impact_repo_count || snap.impact_repos.length;
  const merged = snap.metrics.verified_impact_pr_count || snap.metrics.impact_pr_count;
  return (
    <Shell glow={glowFor(id)} palette={palette} qr={id.qr}>
      <VariantHeader id={id} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BodyTitle
          title={`Contributed to ${count} project${count === 1 ? "" : "s"}`}
          subtitle={`biggest ⭐${fmtNum(snap.metrics.max_impact_repo_stars)} · ${fmtNum(merged)} PRs into popular repos`}
          palette={palette}
        />
        <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
          {repos.map((r) => (
            <ListRow
              key={r.repo}
              left={repoLabel(r.repo)}
              right={`⭐ ${fmtNum(r.stars)}   ·   ${fmtNum(r.prs)} PR · ${fmtNum(r.commits)} commits`}
              palette={palette}
            />
          ))}
        </div>
      </div>
      <Brand palette={palette} />
    </Shell>
  );
}

/** #2 PR 战绩卡 — merged-PR hero + the high-star repos you shipped into. */
function PrCard({ id, snap }: { id: Identity; snap: ProfileSnapshotView }) {
  const { palette, color } = id;
  const m = snap.metrics;
  const intoPopular = m.impact_pr_count;
  const corePct =
    intoPopular > 0 && m.core_impact_pr_count > 0
      ? Math.round((m.core_impact_pr_count / intoPopular) * 100)
      : null;
  const top3 = [...snap.impact_repos].sort((a, b) => b.stars - a.stars).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  const skin = rowSkin(palette);
  return (
    <Shell glow={glowFor(id)} palette={palette} qr={id.qr}>
      <VariantHeader id={id} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <span style={{ fontSize: 112, fontWeight: 800, color, lineHeight: 1 }}>
            {fmtNum(m.merged_pr_count)}
          </span>
          <span style={{ fontSize: 34, color: palette.muted, marginLeft: 16, marginBottom: 12 }}>
            merged PRs
          </span>
        </div>
        <div style={{ display: "flex", fontSize: 26, color: palette.muted, marginTop: 8 }}>
          {fmtNum(intoPopular)} into popular repos
          {corePct !== null ? ` · ${corePct}% core code` : ""}
        </div>
        {top3.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", marginTop: 18 }}>
            <div style={{ display: "flex", fontSize: 22, color: palette.subtle }}>
              Landed in high-star projects
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", marginTop: 4 }}>
              {top3.map((r, i) => (
                <div
                  key={r.repo}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    marginTop: 10,
                    marginRight: 12,
                    padding: "10px 20px",
                    borderRadius: 9999,
                    backgroundColor: skin.bg,
                    border: `1px solid ${skin.border}`,
                    fontSize: 26,
                    fontWeight: 800,
                    color: palette.fg,
                  }}
                >
                  <span style={{ marginRight: 8 }}>{medals[i]}</span>
                  {repoLabel(r.repo)}
                  <span style={{ color: palette.muted, fontWeight: 400, marginLeft: 10 }}>
                    ⭐{fmtNum(r.stars)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <Brand palette={palette} />
    </Shell>
  );
}

/** #3 GitHub 轨迹卡 — lifetime arc + cumulative milestones. */
function PathCard({ id, snap }: { id: Identity; snap: ProfileSnapshotView }) {
  const { palette, color } = id;
  const m = snap.metrics;
  const joinYear = m.created_at ? m.created_at.slice(0, 4) : null;
  const skin = rowSkin(palette);
  const stats = [
    { emoji: "⭐", value: fmtNum(m.total_stars), label: "stars earned" },
    { emoji: "👥", value: fmtNum(m.followers), label: "followers" },
    { emoji: "📦", value: fmtNum(m.public_repos), label: "public repos" },
    { emoji: "🗓️", value: fmtNum(m.contribution_years_active), label: "active years" },
    { emoji: "🔥", value: fmtNum(m.last_year_contributions), label: "this year" },
  ];
  return (
    <Shell glow={glowFor(id)} palette={palette} qr={id.qr}>
      <VariantHeader id={id} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 32, fontWeight: 800, color: palette.fg }}>
            Joined {joinYear ?? "—"}
          </div>
          <div
            style={{
              display: "flex",
              flexGrow: 1,
              height: 4,
              marginLeft: 18,
              marginRight: 18,
              borderRadius: 9999,
              backgroundColor: `${color}66`,
            }}
          />
          <div style={{ display: "flex", fontSize: 32, fontWeight: 800, color }}>
            {fmtNum(m.account_age_years)} yrs
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", marginTop: 4 }}>
          {stats.map((s) => (
            <div
              key={s.label}
              style={{
                display: "flex",
                flexDirection: "column",
                width: 330,
                marginTop: 16,
                marginRight: 16,
                padding: "14px 22px",
                borderRadius: 16,
                backgroundColor: skin.bg,
                border: `1px solid ${skin.border}`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  fontSize: 34,
                  fontWeight: 800,
                  color: palette.fg,
                }}
              >
                <span style={{ marginRight: 10 }}>{s.emoji}</span>
                {s.value}
              </div>
              <div style={{ display: "flex", fontSize: 22, color: palette.muted, marginTop: 2 }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>
      <Brand palette={palette} />
    </Shell>
  );
}

/** #5 signature-work card — concrete contribution first, stars second. */
function WorkCard({ id, snap }: { id: Identity; snap: ProfileSnapshotView }) {
  const { palette } = id;
  const repos = rankProfileWorks({
    username: id.username,
    topRepos: snap.top_repos,
    impactRepos: snap.impact_repos,
    pinnedRepos: snap.pinned_repos,
    signatureWork: snap.signature_work,
  }, 4);
  const count = snap.signature_work?.work_clusters.length || snap.metrics.impact_repo_count || snap.top_repos.length;
  return (
    <Shell glow={glowFor(id)} palette={palette} qr={id.qr}>
      <VariantHeader id={id} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        <BodyTitle
          title="Signature work"
          subtitle={`${fmtNum(count)} representative repos · contribution-first`}
          palette={palette}
        />
        <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
          {repos.map((r) => (
            <ListRow
              key={r.repo}
              left={r.repo}
              right={`⭐ ${fmtNum(r.stars)}${r.prs ? `   ·   ${fmtNum(r.prs)} PRs` : ""}`}
              palette={palette}
            />
          ))}
        </div>
      </div>
      <Brand palette={palette} />
    </Shell>
  );
}

/** True when a snapshot has enough data to render the given specialty card;
 * otherwise the caller falls back to the always-available score card. */
export function variantHasData(
  variant: CardVariant,
  snap: ProfileSnapshotView | null,
): boolean {
  if (!snap) return false;
  switch (variant) {
    case "contrib":
      return snap.impact_repos.length > 0;
    case "pr":
      return snap.metrics.merged_pr_count > 0 || snap.impact_repos.length > 0;
    case "path":
      return snap.metrics.account_age_years > 0 || snap.metrics.created_at !== null;
    case "work":
      return (
        snap.top_repos.length > 0 ||
        snap.impact_repos.length > 0 ||
        (snap.signature_work?.work_clusters.length ?? 0) > 0
      );
    default:
      return false;
  }
}

export function renderVariant(
  variant: CardVariant,
  id: Identity,
  snap: ProfileSnapshotView,
): React.ReactElement {
  switch (variant) {
    case "contrib":
      return <ContribCard id={id} snap={snap} />;
    case "pr":
      return <PrCard id={id} snap={snap} />;
    case "path":
      return <PathCard id={id} snap={snap} />;
    case "work":
      return <WorkCard id={id} snap={snap} />;
    default:
      // unreachable — `score` is handled before this is called
      return <ContribCard id={id} snap={snap} />;
  }
}
