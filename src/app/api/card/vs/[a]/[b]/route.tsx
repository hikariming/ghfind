import { getTranslations } from "next-intl/server";
import { getAccountDetail, getMatchup } from "@/lib/db";
import { BADGE_COLOR, TIER_EN } from "@/lib/badge";
import { normalizeUsername } from "@/lib/username";
import { verdict } from "@/lib/verdict";
import type { AccountDetail } from "@/lib/db";
import { Brand, OgAvatarFrame, PALETTES, Shell, parseQr, parseTheme } from "../../../[username]/cards";
import type { CardPalette } from "../../../[username]/cards";
import { avatarDataUrl, fonts, png, qrDataUrl, qrModuleColor } from "../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Large VS glyph color by verdict bucket. */
const BUCKET_COLOR: Record<string, string> = {
  crush: "#f97316",
  edge: "#f59e0b",
  even: "#a1a1aa",
};

/** One combatant column on the dueling card (score hero, or unjudged placeholder). */
function Player({
  handle,
  detail,
  avatar,
  palette,
  notRated,
}: {
  handle: string;
  detail: AccountDetail | null;
  avatar: string | null;
  palette: CardPalette;
  notRated: string;
}) {
  const color = detail ? BADGE_COLOR[detail.tier] : palette.muted;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          borderRadius: 9999,
          backgroundColor: palette.handleBg,
          border: `2px solid ${color}80`,
          color,
          fontSize: 30,
          fontWeight: 800,
          padding: "6px 20px",
          maxWidth: "100%",
        }}
      >
        @{handle}
      </div>
      <div style={{ display: "flex", marginTop: 16 }}>
        <OgAvatarFrame
          username={handle}
          avatar={avatar}
          tier={detail?.tier ?? "NPC"}
          color={color}
          palette={palette}
        />
      </div>
      {detail ? (
        <>
          <div style={{ display: "flex", marginTop: 14, fontSize: 76, fontWeight: 800, color, lineHeight: 1 }}>
            {detail.final_score.toFixed(1)}
          </div>
          <div style={{ display: "flex", marginTop: 6, fontSize: 30, fontWeight: 800, color }}>
            {TIER_EN[detail.tier]}
          </div>
        </>
      ) : (
        <div style={{ display: "flex", marginTop: 20, fontSize: 34, fontWeight: 800, color: palette.muted }}>
          {notRated}
        </div>
      )}
    </div>
  );
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ a: string; b: string }> },
) {
  const fontList = await fonts();
  const theme = parseTheme(req);
  const palette = PALETTES[theme];
  const { a: rawA, b: rawB } = await ctx.params;
  const url = new URL(req.url);
  const locale = url.searchParams.get("lang") === "zh" ? "zh" : "en";

  const na = normalizeUsername(decodeURIComponent(rawA ?? ""));
  const nb = normalizeUsername(decodeURIComponent(rawB ?? ""));
  const a = (na ?? decodeURIComponent(rawA ?? "")).toLowerCase();
  const b = (nb ?? decodeURIComponent(rawB ?? "")).toLowerCase();

  const [da, db, matchup] = await Promise.all([
    na ? getAccountDetail(a) : Promise.resolve(null),
    nb ? getAccountDetail(b) : Promise.resolve(null),
    na && nb ? getMatchup(a, b) : Promise.resolve(null),
  ]);
  const v = verdict(da, db);
  const t = await getTranslations({ locale, namespace: "vs" });

  const [avA, avB] = await Promise.all([
    avatarDataUrl(da?.avatar_url ?? null),
    avatarDataUrl(db?.avatar_url ?? null),
  ]);

  const vsColor = BUCKET_COLOR[v.bucket] ?? "#f97316";
  // Prefer the stored LLM verdict (matches the /vs page); fall back to the
  // deterministic template.
  const storedVerdict = matchup?.verdict
    ? locale === "en"
      ? matchup.verdict.en || matchup.verdict.zh
      : matchup.verdict.zh || matchup.verdict.en
    : "";
  const line =
    storedVerdict ||
    (v.missing
      ? t("verdictMissing")
      : v.winner === "tie"
        ? t("verdictTie")
        : t(v.templateKey, v.slots));

  const qr = parseQr(req) ? await qrDataUrl(`/vs/${a}/${b}`, qrModuleColor(vsColor, theme)) : null;

  return png(
    <Shell glow={`${vsColor}${theme === "light" ? "30" : "55"}`} palette={palette} qr={qr}>
      {/* Combatants */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Player handle={a} detail={da} avatar={avA} palette={palette} notRated={t("notRated")} />
        <div
          style={{
            display: "flex",
            fontSize: 90,
            fontWeight: 800,
            color: vsColor,
            padding: "0 12px",
          }}
        >
          VS
        </div>
        <Player handle={b} detail={db} avatar={avB} palette={palette} notRated={t("notRated")} />
      </div>

      {/* Verdict */}
      <div
        style={{
          display: "flex",
          fontSize: 28,
          lineHeight: 1.35,
          color: palette.fg,
          marginTop: 8,
        }}
      >
        {line}
      </div>

      <Brand palette={palette} />
    </Shell>,
    fontList,
  );
}
