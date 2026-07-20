import { cache, Suspense } from "react";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import {
  getAccountDetail,
  getFacetRank,
  getProfileComments,
  getProfileSnapshot,
  getSimilarAccounts,
  getUserMatchups,
  filterExistingRepoKeys,
} from "@/lib/db";
import { getCachedScan } from "@/lib/redis";
import { getRankCached } from "@/lib/rank";
import { aggregateLanguages, collectTopics } from "@/lib/profile-insights";
import { PendingProfile } from "./PendingProfile";
import { LiveRoast } from "@/components/LiveRoast";
import { RoastReveal } from "@/components/RoastReveal";
import { ROAST_FRESH_MS } from "@/lib/freshness";
import { splitReport } from "@/lib/report";
import { TIER_LABEL_EN } from "@/lib/badge";
import type { RoastMeta } from "@/lib/types";
import { JsonLd, profileJsonLd } from "@/components/JsonLd";
import { SITE_URL, PUBLIC_INDEX_MIN_SCORE, localeAlternates, localePath, bcp47 } from "@/lib/site";
import { CopyBadge } from "@/components/CopyBadge";
import { MaterialCardPanel } from "@/components/MaterialCardPanel";
import { ProfileShare } from "@/components/ProfileShare";
import { FloatingCommentBubbles } from "@/components/FloatingCommentBubbles";
import { TierAvatarFrame } from "@/components/TierAvatarFrame";
import { DimensionStarChart } from "@/components/DimensionStarChart";
import { nextTier, tierFor } from "@/lib/score";
import { DIMENSIONS } from "@/lib/dimensions";
import { beatPercent } from "@/lib/percentile";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import { normLang } from "@/lib/lang";
import { ProfileReactionsSection } from "@/components/ProfileReactionsSection";
import { RescanButton } from "@/components/RescanButton";
import { BadgeReferralBanner } from "@/components/BadgeReferralBanner";
import { RepoCardLink } from "@/components/RepoCardLink";
import { ProfileLandingBeacon } from "@/components/ProfileLandingBeacon";
import { ChallengeCta } from "@/components/ChallengeCta";
import { CanonicalProfileUpgrade } from "@/components/CanonicalProfileUpgrade";
import { FollowButton } from "@/components/FollowButton";
import { FacetRankLink } from "@/components/FacetRankLink";
import { CommonProjects } from "@/components/CommonProjects";
import { ExplorationBeacon } from "@/components/ExplorationBeacon";
import { auth, authConfigured } from "@/lib/auth";
import { getDeveloperCommonProjectsCached } from "@/lib/project-discovery";
import { rankProfileWorks } from "@/lib/profile-work";
import { ROAST_CACHE_VERSION } from "@/lib/cache-version";
import { LEGACY_READ_FALLBACK } from "@/lib/release-versions";
import {
  ProfileArtifactStatus,
  resolveProfileArtifactState,
  shouldStartProfileRoast,
} from "./ProfileArtifactStatus";

/** True when a Referer header points at github.com (or a subdomain). GitHub sends
 *  `strict-origin-when-cross-origin`, so we only ever see the bare origin — enough
 *  to host-match. Malformed values just fall through to false. */
function isGithubReferer(referer: string | null): boolean {
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
function classifyLandingSource(referer: string | null, fromBadge: boolean): string {
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

// Profile comments must be fresh; score/roast data is still fetched from the DB
// and remains cached at the persistence layer where applicable.
export const dynamic = "force-dynamic";

// Dedupe the DB read between generateMetadata() and the page render.
const getDetail = cache((username: string) => getAccountDetail(username));
// Dedupe the cached-scan read (pending-profile fallback) across the same pair.
const getLiveScan = cache((username: string) => getCachedScan(username));

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; username: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}): Promise<Metadata> {
  const { locale, username } = await params;
  const t = await getTranslations({ locale, namespace: "detailMeta" });
  const decoded = decodeURIComponent(username);
  const d = await getDetail(decoded);
  if (!d) {
    // No persisted row yet. A cached scan or the `?roasting=1` handoff marker
    // means we render the live-roast pending shell rather than 404 — give it a
    // title and keep it out of search (it's transient).
    const scan = await getLiveScan(decoded);
    const roasting = (await searchParams)?.roasting === "1";
    if (scan || roasting) {
      return {
        title: t("pendingTitle", { username: scan?.metrics.username ?? decoded }),
        robots: { index: false, follow: true },
      };
    }
    return { title: t("notFoundTitle") };
  }

  const tt = await getTranslations({ locale, namespace: "tiers" });
  const tierName = tt(`${TIER_KEY[d.tier]}.name`);
  const title = t("title", {
    username: d.username,
    score: d.final_score.toFixed(2),
    tier: tierName,
  });
  const tags = normLang(locale) === "en" ? d.tags.en : d.tags.zh;
  const description = tags.length
    ? t("descWithTags", { tags: tags.map((x) => `#${x}`).join(" "), username: d.username })
    : t("descPlain", { username: d.username });
  // The flex card doubles as the social preview image (resolved absolute via
  // metadataBase in layout.tsx) — so shared /u links render a rich card.
  const image = `/api/card/${d.username}`;
  const imageAlt = `${d.username} GitHub score card on ghfind`;
  const path = localePath(locale, `/u/${d.username}`);
  // Keep low-score profiles out of search results: they name real people, so a
  // "NPC"/"拉完了" page shouldn't rank on someone's handle. Still reachable and
  // shareable — just not indexed. Mirrors the sitemap floor.
  const indexable = d.final_score >= PUBLIC_INDEX_MIN_SCORE;
  return {
    title,
    description,
    robots: indexable ? undefined : { index: false, follow: true },
    // Canonicalize on the stored slug so casing variants (GitHub handles are
    // case-insensitive: /u/Torvalds vs /u/torvalds) consolidate to one URL.
    alternates: localeAlternates(locale, `/u/${d.username}`),
    openGraph: {
      title,
      description,
      url: path,
      type: "website",
      images: [{ url: image, width: 1200, height: 630, alt: imageAlt, type: "image/png" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: image, alt: imageAlt }],
    },
  };
}

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; username: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { locale, username } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const isAdvxCampaign = query.campaign === "advx";
  const decoded = decodeURIComponent(username);
  const d = await getDetail(decoded);
  if (!d) {
    // First-time username being roasted right now: no `scores` row yet. Render
    // the live pending shell when we have a scan to show — either the server-side
    // cache, or the `?roasting=1` handoff (the shell reads the scan the homepage
    // stashed in sessionStorage). LiveRoast refreshes into the full profile on
    // completion. Otherwise it's a genuine unknown handle → 404.
    const scan = await getLiveScan(decoded);
    const roasting = query.roasting === "1";
    if (!scan && !roasting) notFound();
    return (
      <PendingProfile
        username={decoded}
        initialScan={scan ?? null}
        fromHome={roasting}
        advx={isAdvxCampaign}
      />
    );
  }

  const t = await getTranslations("detail");
  const tDim = await getTranslations("dimensions");
  const tTier = await getTranslations("tiers");
  const style = tierStyle(d.tier);
  const tierKey = TIER_KEY[d.tier];
  const lang = normLang(locale);
  // English visitors read the English-cached roast; fall back to the empty state
  // (not the Chinese report) so the page never mixes languages.
  const roast = lang === "en" ? d.roast_en : d.roast;
  // The bilingual one-liner is generated in one call, so it's available in the
  // visitor's language even when the full report exists only in the other one.
  // Empty for legacy rows — those still carry the one-liner inline in `roast`.
  const roastLine = lang === "en" ? d.roast_line.en : d.roast_line.zh;
  // Homepage handoff: the input box navigated here with `?roasting=1`. That
  // arrival must always get the result popup — replayed from the stored roast
  // when it's still fresh, or via a forced regeneration when it has gone stale
  // (the homepage's /api/scan call just re-scanned, so the score is current).
  // Direct visits / shared links (no param) keep the popup-free SSR page.
  const fromHome = query.roasting === "1";
  const refreshRunId = typeof query.refresh_run_id === "string" ? query.refresh_run_id : null;
  const legacyReadFallback = d.legacy_read_fallback;
  // eslint-disable-next-line react-hooks/purity -- force-dynamic Server Component: rendered per request, so wall-clock staleness here is intentional (and the server re-validates before spending LLM credit)
  const staleReroast = !legacyReadFallback && fromHome && Boolean(roast) && Date.now() - d.scanned_at > ROAST_FRESH_MS;
  // A profile read must stay read-only. Only the explicit homepage handoff may
  // mount LiveRoast and spend LLM credit; direct/shared profile visits show a
  // stable pending state even if a scan happens to remain in Redis.
  const shouldStreamRoast =
    !legacyReadFallback &&
    shouldStartProfileRoast({
      explicitHandoff: fromHome,
      hasReport: Boolean(roast),
      staleReport: staleReroast,
    });
  const liveScan = shouldStreamRoast ? await getLiveScan(d.username) : null;
  // getAccountDetail only exposes report text after both its score and the
  // selected-language roast pass the canonical version checks. Preserve that
  // boundary here instead of guessing compatibility from report contents.
  const selectedRoastVersion = roast
    ? legacyReadFallback
      ? LEGACY_READ_FALLBACK.roast
      : ROAST_CACHE_VERSION
    : null;
  const artifactState = resolveProfileArtifactState({
    scoreVersion: d.score_version,
    sourceCollectionVersion: d.score_source_collection_version,
    sourceSnapshotHash: d.score_source_snapshot_hash,
    roastVersion: selectedRoastVersion,
  });
  const artifactCopy =
    artifactState === "stale-score"
      ? {
          title: t("scoreStateStaleTitle"),
          body: t("scoreStateStaleBody"),
        }
      : artifactState === "report-pending"
        ? {
            title: t("scoreStatePendingTitle"),
            body: t("scoreStatePendingBody"),
          }
        : {
            title: t("scoreStateReadyTitle"),
            body: t("scoreStateReadyBody"),
          };
  const [similar, comments, snap, rank, session, battles, facetRank] =
    await Promise.all([
      getSimilarAccounts(d.username, d.final_score, d.sub_scores),
      getProfileComments(d.username),
      getProfileSnapshot(d.username),
      getRankCached(d.final_score),
      authConfigured() ? auth() : Promise.resolve(null),
      getUserMatchups(d.username),
      getFacetRank(d.username, d.final_score),
    ]);
  const commonProjects = Array.from(
    new Map(
      (
        await Promise.all(
          similar.slice(0, 3).map((account) =>
            getDeveloperCommonProjectsCached(d.username, account.username, 3),
          ),
        )
      )
        .flat()
        .map((project) => [project.repo.repo_key, project]),
    ).values(),
  ).slice(0, 6);
  // Inline re-detect is self-service: only the signed-in owner sees it on their
  // own profile. GitHub handles are case-insensitive, so compare normalized.
  const isOwner =
    session?.user?.login?.toLowerCase() === d.username.toLowerCase();
  // Badge-landing hook: a visitor arriving from a GitHub README badge (Referer
  // github.com) or an explicit ?ref=badge, looking at someone else's page, gets
  // nudged into a PK against the owner. Reading headers is free here — the page
  // is already force-dynamic. Suppressed for the owner (can't duel yourself).
  const refParam = query.ref;
  const fromBadgeRef = refParam === "badge";
  const referer = (await headers()).get("referer");
  const fromGithub = isGithubReferer(referer);
  const badgeSignal: "referer" | "ref" | null = fromBadgeRef
    ? "ref"
    : fromGithub
      ? "referer"
      : null;
  const showBadgeBanner = badgeSignal !== null && !isOwner;
  // Funnel top: attribute this profile view to a coarse acquisition source so the
  // landing → PK/badge action → spread loop can be read end-to-end.
  const landingSource = classifyLandingSource(referer, fromBadgeRef);
  // Milestone hint: points to the next tier line, plus the "beat %" so far.
  const promo = nextTier(d.final_score);
  const promoGap = promo ? (promo.threshold - d.final_score).toFixed(2) : null;
  const promoTierName = promo ? tTier(`${TIER_KEY[promo.tier]}.name`) : null;
  const beat = rank ? beatPercent(rank.below, rank.total) : null;
  // Popup payload for the homepage handoff — the fresh replay (RoastReveal), the
  // stale re-roast seed and the missing-language seed all reuse it. Built
  // entirely from the row plus the rank already computed above; delta is 0
  // because a replay adjusts nothing.
  const revealMeta: RoastMeta | null =
    fromHome
      ? {
          final_score: d.final_score,
          tier: d.tier,
          tier_label:
            lang === "en" ? TIER_LABEL_EN[d.tier] : tierFor(d.final_score).tier_label,
          delta: 0,
          percentile: rank ? { beat, total: rank.total, rank: rank.rank } : null,
          tags: d.tags,
          roast_line: d.roast_line,
        }
      : null;
  const revealBody = fromHome && roast ? splitReport(roast).body : "";
  const detailPath = localePath(locale, `/u/${d.username}`);
  const dimensionLabels = Object.fromEntries(
    DIMENSIONS.map((key) => [key, tDim(key)]),
  ) as Record<(typeof DIMENSIONS)[number], string>;

  // Evidence blocks (only when a sedimented snapshot exists).
  const impactRepos = snap
    ? [...snap.impact_repos].sort((a, b) => b.stars - a.stars).slice(0, 6)
    : [];
  const representativeWorks = snap
    ? rankProfileWorks({
        username: d.username,
        topRepos: snap.top_repos,
        impactRepos: snap.impact_repos,
        pinnedRepos: snap.pinned_repos,
        signatureWork: snap.signature_work,
      })
    : [];
  const languages = snap ? aggregateLanguages(snap.top_repos) : [];
  const topics = snap ? collectTopics(snap.top_repos) : [];
  const organizations = snap?.organizations ?? [];
  // Repo cards route into their internal project page (reclaiming the click that
  // otherwise leaks to github.com) — but only where a project page has content,
  // i.e. the repo exists as a first-class `repos` row. One indexed lookup over
  // both representative and impact repos; failure → empty set → all
  // cards keep their external GitHub links (pre-Phase-B behavior).
  const existingRepoKeys = snap
    ? await filterExistingRepoKeys([
        ...impactRepos.map((r) => r.repo.toLowerCase()),
        ...representativeWorks.map((r) => r.repo.toLowerCase()),
      ])
    : new Set<string>();
  /** Locale-relative internal project page path for an "owner/name" key. */
  const repoHref = (key: string) => {
    const [owner, name] = key.split("/");
    return `/developers/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  };
  const bio = snap?.bio ?? null;
  const company = snap?.company ?? null;
  const nf = new Intl.NumberFormat(bcp47(locale), {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const advxDivider =
    "before:mx-4 before:mb-6 before:block before:h-px before:bg-white/10 before:content-['']";
  const contentSectionClass = isAdvxCampaign
    ? `mt-6 bg-transparent p-0 ${advxDivider}`
    : "mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-6";
  const dimensionSectionClass = isAdvxCampaign
    ? contentSectionClass
    : "rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-6";
  const impactSectionClass = isAdvxCampaign
    ? `mt-6 bg-transparent p-0 ${advxDivider}`
    : "mb-6 rounded-2xl border border-amber-300/25 bg-amber-500/[0.05] p-5 sm:p-6";
  const similarSection = similar.length > 0 && (
    <section className={contentSectionClass}>
      <h2 className="mb-1 text-base font-bold text-zinc-200">{t("similarHeading")}</h2>
      <p className="mb-4 text-xs text-zinc-400">{t("similarSub")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {similar.map((s) => {
          const st = tierStyle(s.tier);
          const tag = lang === "en" ? s.tags.en[0] : s.tags.zh[0];
          return (
            <Link
              key={s.username}
              href={`/u/${s.username}`}
              prefetch={false}
              className={
                isAdvxCampaign
                  ? "flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-3 hover:bg-white/[0.06]"
                  : "flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]"
              }
            >
              {s.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.avatar_url} alt={s.username} className="h-8 w-8 shrink-0 rounded-full" />
              ) : (
                <div className="h-8 w-8 shrink-0 rounded-full bg-white/10" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-zinc-200">@{s.username}</div>
                {tag && <div className="truncate text-[11px] text-orange-200/80">#{tag}</div>}
              </div>
              <span className={`shrink-0 text-end text-sm font-black tabular-nums ${st.text}`}>
                {st.emoji} {s.final_score.toFixed(2)}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );

  return (
    <main className="relative isolate flex w-full flex-1 justify-center px-5 py-14 sm:py-20">
      <FloatingCommentBubbles
        key={d.username}
        lang={lang}
        profileUsername={d.username}
        initialComments={comments}
      />
      {legacyReadFallback && refreshRunId && (
        <CanonicalProfileUpgrade username={d.username} runId={refreshRunId} locale={locale} />
      )}
      <div className="relative z-10 flex w-full max-w-4xl flex-col">
        <JsonLd
          data={profileJsonLd({
            username: d.username,
            displayName: d.display_name,
            avatarUrl: d.avatar_url,
            profileUrl: d.profile_url,
            score: d.final_score,
            locale,
            scannedAt: d.scanned_at,
          })}
        />
        <ProfileLandingBeacon source={landingSource} tier={d.tier} owner={isOwner} />
        <ExplorationBeacon
          item={{
            kind: "developer",
            key: d.username.toLowerCase(),
            title: `@${d.username}`,
            subtitle: d.display_name ?? undefined,
            href: `/u/${encodeURIComponent(d.username)}`,
          }}
        />
        {isAdvxCampaign ? (
          <Link
            href="/advx?theme=dark"
            prefetch={false}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            ← 返回
          </Link>
        ) : (
          <Link
            href="/leaderboard"
            prefetch={false}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            {t("back")}
          </Link>
        )}
        {showBadgeBanner && (
          <BadgeReferralBanner owner={d.username} signal={badgeSignal!} />
        )}

      <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Left: sticky identity sidebar — score stays visible while reading */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-8 lg:w-80 lg:shrink-0">
      {/* Header card */}
      <div
        className={`animate-pop flex flex-col items-center text-center ${
          isAdvxCampaign
            ? "bg-transparent p-0"
            : "rounded-2xl border border-white/10 bg-white/[0.05] p-6 ring-1"
        } ${style.ring}`}
        style={isAdvxCampaign ? undefined : { boxShadow: `0 0 80px -20px ${style.glow}` }}
      >
        <h1 className="max-w-full">
          <a
            href={d.profile_url ?? `https://github.com/${d.username}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-block max-w-full break-all text-xl font-black leading-tight ${style.text} ${
              isAdvxCampaign
                ? ""
                : `rounded-full bg-black/35 px-4 py-1.5 ring-1 ${style.ring} hover:bg-black/45`
            }`}
            style={{ boxShadow: `0 0 28px -10px ${style.glow}` }}
          >
            @{d.username}
          </a>
        </h1>
        {d.display_name && (
          <div className="mt-2 max-w-full truncate text-sm font-medium text-zinc-300">
            {d.display_name}
          </div>
        )}
        {bio && (
          <div className="mt-2 line-clamp-2 max-w-md text-sm text-zinc-400">{bio}</div>
        )}
        <TierAvatarFrame
          username={d.username}
          avatarUrl={d.avatar_url}
          tier={d.tier}
          size="lg"
          className="mt-5"
        />
        <div className={`mt-4 text-6xl font-black tabular-nums ${style.text}`}>
          {d.final_score.toFixed(2)}
          <span className="text-2xl text-zinc-600">/100</span>
        </div>
        <div className={`mt-1 text-2xl font-bold ${style.text}`}>
          {style.emoji} {tTier(`${tierKey}.name`)}
        </div>
        <div className="mt-1 text-sm font-medium text-zinc-300">
          {tTier(`${tierKey}.blurb`)}
        </div>

        {isAdvxCampaign && roastLine && (
          <p
            data-advx-mobile-roast
            className="mt-4 w-full border-s-2 border-orange-400/50 ps-4 text-start text-[0.95rem] leading-relaxed text-zinc-100 lg:hidden"
          >
            🔥 {roastLine}
          </p>
        )}

        {d.tags.zh.length + d.tags.en.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {d.tags.zh.map((tag, i) => (
              <span
                key={`zh-${tag}-${i}`}
                className="rounded-full bg-orange-500/10 px-2 py-0.5 text-xs text-orange-200/90"
              >
                #{tag}
              </span>
            ))}
            {d.tags.en.map((tag, i) => (
              <span
                key={`en-${tag}-${i}`}
                className="rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200/90"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}

        {(organizations.length > 0 || company) && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            {company && (
              <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-zinc-300">
                🏢 {company}
              </span>
            )}
            {organizations.map((org) => (
              <a
                key={org}
                href={`https://github.com/${org}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-zinc-300 hover:bg-white/10"
              >
                @{org}
              </a>
            ))}
          </div>
        )}
      </div>

      <ProfileArtifactStatus
        state={artifactState}
        title={artifactCopy.title}
        body={artifactCopy.body}
      />

      {/* My standing — concrete rank, "beat %", a milestone hint to the next
          tier, and an inline re-detect button to refresh the score. */}
      <div
        className={
          isAdvxCampaign
            ? `mt-5 bg-transparent p-0 text-center ${advxDivider}`
            : "mt-5 rounded-2xl border border-orange-300/30 bg-orange-500/[0.07] p-4 text-center"
        }
      >
        {!isAdvxCampaign && (
          <div className="text-xs font-semibold uppercase tracking-wide text-orange-200/90">
            {t("rankTitle")}
          </div>
        )}
        {rank ? (
          <>
            <div className={`mt-1 text-4xl font-black tabular-nums ${style.text}`}>
              #{rank.rank}
              <span className="ms-1 text-sm font-medium text-zinc-400">
                {t("rankUnit", { total: rank.total })}
              </span>
            </div>
            {beat != null && (
              <div className="mt-0.5 text-xs font-medium text-zinc-300">
                {t("beatInline", { beat: beat.toFixed(1) })}
              </div>
            )}
          </>
        ) : (
          <div className="mt-1 text-sm font-medium text-zinc-300">{t("rankUnranked")}</div>
        )}
        <div className="mt-2 text-xs font-medium text-zinc-200">
          {promo
            ? t("milestoneNext", { tier: promoTierName!, gap: promoGap! })
            : t("milestoneCapped")}
        </div>
        {facetRank && (
          <FacetRankLink
            facetValue={facetRank.facetValue}
            rank={facetRank.rank}
            ahead={facetRank.ahead?.username ?? null}
            username={d.username}
          />
        )}
        {/* Turn the profile into a transit station: challenge this dev to a PK.
            The owner instead seeds the home Omnibox to pull others in against
            themselves (can't duel yourself). */}
        {isOwner ? (
          <Link
            href={`/?username=${encodeURIComponent(`${d.username} vs `)}`}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-orange-400/40 px-4 py-2 text-sm font-semibold text-orange-200 transition hover:bg-orange-500/10"
          >
            <span aria-hidden>⚔️</span>
            {t("challengeOwner")}
          </Link>
        ) : (
          <>
            <ChallengeCta
              opponent={d.username}
              source="profile_btn"
              variant="banner"
              label={t("challengeCta")}
              goLabel={t("challengeGo")}
              placeholder={t("challengePlaceholder")}
              selfHint={t("challengeSelf")}
              invalidHint={t("challengeInvalid")}
              className="mt-3"
            />
            {/* Watch this handle — feeds the homepage following module. */}
            <FollowButton username={d.username} className="mt-3" />
          </>
        )}
        {isOwner && (
          <RescanButton username={d.username} scannedAt={d.scanned_at} className="mt-3" />
        )}
      </div>

      {isAdvxCampaign && (
        <div className={`lg:hidden ${advxDivider}`}>
          <MaterialCardPanel
            baseUrl={SITE_URL}
            username={d.username}
            version={d.scanned_at}
          />
        </div>
      )}

      <Suspense
        fallback={
          <div className="h-28 animate-pulse rounded-2xl border border-orange-300/15 bg-orange-500/[0.035]" />
        }
      >
        <ProfileReactionsSection
          key={`reactions-${d.username}`}
          username={d.username}
          redirectTo={detailPath}
          flat={isAdvxCampaign}
        />
      </Suspense>

        <ProfileShare
          username={d.username}
          name={d.display_name}
          avatarUrl={d.avatar_url}
          score={d.final_score}
          tier={d.tier}
          tierLabel={tTier(`${tierKey}.blurb`)}
          beat={beat}
          tags={d.tags}
        />
        {!isAdvxCampaign && (
          <CopyBadge
            baseUrl={SITE_URL}
            username={d.username}
            version={d.scanned_at}
            surface="profile"
          />
        )}
        </aside>

        {/* Right: evidence + report */}
        <div className="flex min-w-0 flex-1 flex-col">

      {isAdvxCampaign && (
        <div className="mb-6 hidden lg:block">
          <MaterialCardPanel
            baseUrl={SITE_URL}
            username={d.username}
            version={d.scanned_at}
          />
        </div>
      )}

      {/* Notable contributions — popular repos the user has shipped to (the
          hardest evidence behind the ecosystem-impact dimension). Surfaced first
          as the strongest signal on the profile. */}
      {impactRepos.length > 0 && (
        <section className={impactSectionClass}>
          <h2 className="mb-1 text-base font-bold text-amber-200">{t("impactHeading")}</h2>
          <p className="mb-4 text-xs text-zinc-400">{t("impactSub")}</p>
          <div className="flex flex-col gap-2">
            {impactRepos.map((r) => {
              const key = r.repo.toLowerCase();
              const internal = existingRepoKeys.has(key);
              const cardClass =
                "flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]";
              const inner = (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
                    {r.repo}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                    ⭐ {nf.format(r.stars)}
                    {(r.commits > 0 || r.prs > 0) && (
                      <span className="ms-2 text-zinc-500">
                        {r.commits > 0 && `${nf.format(r.commits)} ${t("commits")}`}
                        {r.commits > 0 && r.prs > 0 && " · "}
                        {r.prs > 0 && `${nf.format(r.prs)} ${t("prs")}`}
                      </span>
                    )}
                  </span>
                </>
              );
              return internal ? (
                <RepoCardLink
                  key={r.repo}
                  href={repoHref(key)}
                  repo={r.repo}
                  surface="impact"
                  className={cardClass}
                >
                  {inner}
                </RepoCardLink>
              ) : (
                <a
                  key={r.repo}
                  href={`https://github.com/${r.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cardClass}
                >
                  {inner}
                </a>
              );
            })}
          </div>
        </section>
      )}

      {/* Dimension breakdown */}
      <section className={dimensionSectionClass}>
        <h2 className="mb-4 text-base font-bold text-zinc-200">{t("dimensionsHeading")}</h2>
        <DimensionStarChart
          scores={d.sub_scores}
          labels={dimensionLabels}
          tier={d.tier}
          compact={isAdvxCampaign}
        />
      </section>

      {/* Representative work: concrete contribution first, stars second. */}
      {representativeWorks.length > 0 && (
        <section className={contentSectionClass}>
          <h2 className="mb-1 text-base font-bold text-zinc-200">{t("worksHeading")}</h2>
          <p className="mb-4 text-xs text-zinc-400">{t("worksSub")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {representativeWorks.map((work) => {
              const key = work.repo.toLowerCase();
              const internal = existingRepoKeys.has(key);
              const cardClass = isAdvxCampaign
                ? "flex flex-col gap-1 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-3 hover:bg-white/[0.06]"
                : "flex flex-col gap-1 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]";
              const evidence = work.examples?.[0] ?? work.description;
              const inner = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
                      {work.repo}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                      ⭐ {nf.format(work.stars)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                    {work.prs ? <span>{nf.format(work.prs)} {t("prs")}</span> : null}
                    {work.commits ? <span>{nf.format(work.commits)} {t("commits")}</span> : null}
                    {work.orgContextRepo ? <span>↔ {work.orgContextRepo}</span> : null}
                    {work.language ? <span>{work.language}</span> : null}
                  </div>
                  {evidence && (
                    <p className="line-clamp-2 text-xs text-zinc-400">{evidence}</p>
                  )}
                </>
              );
              return internal ? (
                <RepoCardLink
                  key={work.repo}
                  href={repoHref(key)}
                  repo={key}
                  surface="featured"
                  className={cardClass}
                >
                  {inner}
                </RepoCardLink>
              ) : (
                <a
                  key={work.repo}
                  href={`https://github.com/${work.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cardClass}
                >
                  {inner}
                </a>
              );
            })}
          </div>
        </section>
      )}

      <CommonProjects projects={commonProjects} flat={isAdvxCampaign} />

      {similarSection}

      {/* Stack & domains — aggregated language mix + topic tags. */}
      {(languages.length > 0 || topics.length > 0) && (
        <section className={contentSectionClass}>
          <h2 className="mb-4 text-base font-bold text-zinc-200">{t("stackHeading")}</h2>
          {languages.length > 0 && (
            <div className="mb-4">
              <div className="mb-2 text-xs text-zinc-400">{t("stackLangLabel")}</div>
              <div className="flex flex-col gap-2">
                {languages.map((l) => (
                  <div key={l.name}>
                    <div className="mb-1 flex items-baseline justify-between text-sm">
                      <span className="text-zinc-300">{l.name}</span>
                      <span className="tabular-nums text-zinc-400">{l.pct}%</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-sky-400/70"
                        style={{ width: `${l.pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {topics.length > 0 && (
            <div>
              <div className="mb-2 text-xs text-zinc-400">{t("stackTopicsLabel")}</div>
              <div className="flex flex-wrap gap-1.5">
                {topics.map((topic) => (
                  <span
                    key={topic}
                    className="rounded-full border border-emerald-400/30 bg-emerald-500/12 px-2.5 py-1 text-xs font-semibold text-emerald-200/90"
                  >
                    {topic}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Battles — this dev's PK matchups (internal links + entertainment) */}
      {battles.length > 0 && (
        <section className={contentSectionClass}>
          <h2 className="mb-1 text-base font-bold text-zinc-200">{t("battlesHeading")}</h2>
          <p className="mb-4 text-xs text-zinc-400">{t("battlesSub")}</p>
          <div className="flex flex-col gap-2">
            {battles.map((m) => {
              const meIsA = m.handleA.toLowerCase() === d.username.toLowerCase();
              const opponent = meIsA ? m.handleB : m.handleA;
              const myScore = meIsA ? m.scoreA : m.scoreB;
              const oppScore = meIsA ? m.scoreB : m.scoreA;
              const outcome =
                m.winner === null
                  ? "tie"
                  : m.winner.toLowerCase() === d.username.toLowerCase()
                    ? "win"
                    : "loss";
              const badge =
                outcome === "win"
                  ? { text: t("battleWin"), cls: "bg-emerald-500/15 text-emerald-300" }
                  : outcome === "loss"
                    ? { text: t("battleLoss"), cls: "bg-rose-500/15 text-rose-300" }
                    : { text: t("battleTie"), cls: "bg-zinc-500/15 text-zinc-300" };
              return (
                <Link
                  key={`${m.handleA}-${m.handleB}`}
                  href={`/vs/${m.handleA}/${m.handleB}`}
                  prefetch={false}
                  className={
                    isAdvxCampaign
                      ? "flex items-center gap-3 border-b border-white/10 py-3 last:border-b-0 hover:bg-white/[0.03]"
                      : "flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]"
                  }
                >
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${badge.cls}`}>
                    {badge.text}
                  </span>
                  <div className="min-w-0 flex-1 truncate text-sm text-zinc-300">
                    vs <span className="font-medium text-zinc-200">@{opponent}</span>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                    {myScore.toFixed(1)} : {oppScore.toFixed(1)}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Full roast report */}
      <section
        className={
          isAdvxCampaign
            ? `mt-6 bg-transparent p-0 ${advxDivider}`
            : "mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-7"
        }
      >
        <h2 className="mb-3 text-lg font-bold text-orange-400">{t("roastHeading")}</h2>
        {/* LLM content only exists in zh/en; a ja/ko visitor reads the English
            side, so tell them why the report language differs from the UI. */}
        {lang !== locale && (roast || roastLine) && (
          <p className="mb-3 text-xs text-zinc-500">{t("reportLangNotice")}</p>
        )}
        {/* Savage one-liner (current language) — shown above the full report.
            The stale re-roast stream renders its own line, so skip it there. */}
        {roastLine && !shouldStreamRoast && (
          <p
            className={`${isAdvxCampaign ? "hidden lg:block" : ""} mb-4 rounded-xl border border-orange-500/30 bg-orange-500/[0.08] p-4 text-[0.95rem] leading-relaxed text-zinc-100`}
          >
            🔥 {roastLine}
          </p>
        )}
        {roast ? (
          staleReroast ? (
            // Homepage handoff onto a >24h roast: the popup opens IMMEDIATELY
            // (seeded with the stored result) while the regeneration streams
            // over the old report; the popup's card updates in place when the
            // new meta lands. On failure it simply keeps the stored content.
            <LiveRoast
              username={d.username}
              scan={liveScan}
              refresh
              openModalOnMount
              fallbackReport={revealBody}
              fallbackMeta={revealMeta ?? undefined}
              profileName={d.display_name}
              profileAvatarUrl={d.avatar_url}
              orgs={organizations}
              advx={isAdvxCampaign}
              materialVersion={d.scanned_at}
            />
          ) : (
            <>
              {fromHome && revealMeta && (
                // Homepage handoff onto a fresh (<24h) roast: the SSR report
                // stays, and the stored result pops as the share modal.
                <RoastReveal
                  username={d.username}
                  name={d.display_name}
                  avatarUrl={d.avatar_url}
                  meta={revealMeta}
                  orgs={organizations}
                  advx={isAdvxCampaign}
                  materialVersion={d.scanned_at}
                />
              )}
              <div dir="ltr" className="report text-[0.95rem] text-zinc-200">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{roast}</ReactMarkdown>
              </div>
            </>
          )
        ) : shouldStreamRoast ? (
          <LiveRoast
            username={d.username}
            scan={liveScan}
            openModalOnMount={fromHome}
            fallbackMeta={fromHome ? (revealMeta ?? undefined) : undefined}
            profileName={d.display_name}
            profileAvatarUrl={d.avatar_url}
            orgs={organizations}
            advx={isAdvxCampaign}
            materialVersion={d.scanned_at}
          />
        ) : (
          <p className="text-sm text-zinc-400">
            {t.rich("roastEmpty", {
              a: (c) => (
                <Link href="/" className="text-orange-400 hover:underline">
                  {c}
                </Link>
              ),
            })}
          </p>
        )}
      </section>
        </div>
      </div>

      <footer className="mt-10 text-center">
        <Link
          href="/"
          className="inline-block rounded-full bg-orange-600 px-5 py-2 text-sm font-medium text-white hover:bg-orange-500"
        >
          {t("selfCta")}
        </Link>
      </footer>
      </div>
    </main>
  );
}
