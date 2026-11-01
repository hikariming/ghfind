import { getGoLiveProfileScan, getGoProfilePresentation } from "@/lib/go-profile.server";
import { getProfileComments } from "@/lib/db";
import { ROAST_FRESH_MS } from "@/lib/freshness";
import { normLang } from "@/lib/lang";
import { PUBLIC_INDEX_MIN_SCORE, SITE_URL } from "@/lib/site";
import { TIER_KEY } from "@/lib/tier";
import { adventurerLevel, realmForScore } from "@/lib/realm";
import type { Translator } from "@/lib/translator";
import { shouldStartProfileRoast } from "@/app/[locale]/u/[username]/ProfileArtifactStatus";

/** /u/[username] logic shared by the Next page and apps/web. */

/** True when a Referer header points at github.com (or a subdomain). GitHub sends
 *  `strict-origin-when-cross-origin`, so we only ever see the bare origin — enough
 *  to host-match. Malformed values just fall through to false. */
export function isGithubReferer(referer: string | null): boolean {
  if (!referer) return false;
  try {
    return /(^|\.)github\.com$/i.test(new URL(referer).hostname);
  } catch {
    return false;
  }
}

const SITE_HOST = (() => {
  try {
    return new URL(SITE_URL).hostname.toLowerCase();
  } catch {
    return "";
  }
})();

/** Coarse acquisition bucket for the profile-landing beacon — kept low-cardinality
 *  so the Analytics group stays readable. `?ref=badge` wins (explicit badge tag),
 *  then the Referer host decides. Mirrors the referrerHostname families we already
 *  see in Web Analytics (github / search / social) plus internal vs. direct. */
export function classifyLandingSource(referer: string | null, fromBadge: boolean): string {
  if (fromBadge) return "badge";
  if (!referer) return "direct";
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return "direct";
  }
  if (host === SITE_HOST || host === "localhost") return "internal";
  if (/(^|\.)github\.com$/.test(host)) return "github";
  if (/(^|\.)(google|bing|duckduckgo|baidu|yandex|ecosia|sogou)\./.test(host)) return "search";
  if (
    /(^|\.)(t\.co|x\.com|twitter\.com|facebook\.com|linkedin\.com|weibo\.com|reddit\.com|t\.me|linux\.do|news\.ycombinator\.com|instagram\.com)$/.test(
      host,
    )
  )
    return "social";
  return "referral";
}

export type ProfilePresentation = NonNullable<Awaited<ReturnType<typeof getGoProfilePresentation>>>;
export type ProfileDetail = ProfilePresentation["detail"];
export type LiveProfileScan = Awaited<ReturnType<typeof getGoLiveProfileScan>>;
export type ProfileComments = Awaited<ReturnType<typeof getProfileComments>>;

/**
 * The per-request facts a full profile render needs beyond the presentation:
 * whether the homepage handoff must (re)stream the roast — evaluated against
 * the wall clock here, on the server, so hydration sees the same answer — and
 * the live scan that streaming needs.
 */
export async function loadProfileRoastState(
  d: ProfileDetail,
  locale: string,
  fromHome: boolean,
  getLiveScan: (username: string) => Promise<LiveProfileScan>,
) {
  const roast = normLang(locale) === "en" ? d.roast_en : d.roast;
  const staleReroast =
    !d.legacy_read_fallback && fromHome && Boolean(roast) && Date.now() - d.scanned_at > ROAST_FRESH_MS;
  const shouldStreamRoast =
    !d.legacy_read_fallback &&
    shouldStartProfileRoast({ explicitHandoff: fromHome, hasReport: Boolean(roast), staleReport: staleReroast });
  const liveScan = shouldStreamRoast ? await getLiveScan(d.username) : null;
  return { staleReroast, shouldStreamRoast, liveScan };
}

/**
 * Metadata for a scored profile. Low-score profiles stay out of search results:
 * they name real people, so a low-realm page shouldn't rank on someone's
 * handle (still reachable and shareable — just not indexed; mirrors the
 * sitemap floor). The flex card doubles as the social preview image.
 */
export function profileMetadata(locale: string, d: ProfileDetail, t: Translator, tt: Translator) {
  const realm = realmForScore(d.final_score);
  const realmName = tt(`${realm.id}.name`);
  const title = t("title", {
    username: d.username,
    level: adventurerLevel(d.final_score),
    realm: realmName,
    // legacy keys kept for older message catalogs during rollout
    score: d.final_score.toFixed(2),
    tier: realmName,
  });
  const tags = normLang(locale) === "en" ? d.tags.en : d.tags.zh;
  const description = tags.length
    ? t("descWithTags", { tags: tags.map((x) => `#${x}`).join(" "), username: d.username })
    : t("descPlain", { username: d.username });
  return {
    title,
    description,
    image: `/api/card/${d.username}`,
    imageAlt: `${d.username} GitHub score card on ghfind`,
    // Canonicalize on the stored slug so casing variants (GitHub handles are
    // case-insensitive: /u/Torvalds vs /u/torvalds) consolidate to one URL.
    path: `/u/${d.username}`,
    indexable: d.final_score >= PUBLIC_INDEX_MIN_SCORE,
  };
}
