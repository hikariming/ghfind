import ReactMarkdown from "react-markdown";
import { RoastReport } from "../RoastReport";
import remarkGfm from "remark-gfm";
import { Link } from "@/i18n/navigation";
import { LiveRoast } from "@/components/LiveRoast";
// Profile popup disabled 2026-10-28 (owner request); keep import for possible re-enable
// import { RoastReveal } from "@/components/RoastReveal";
import { splitReport } from "@/lib/report";
import { TIER_LABEL_EN } from "@/lib/badge";
import { AdventurerLevel } from "@/components/realm/AdventurerLevel";
import { RealmChip } from "@/components/realm/RealmGlyph";
import { nextRealm, realmCssVars, realmForScore, formatAdventurerLevel, preciseScoreTitle } from "@/lib/realm";
import type { RoastMeta } from "@/lib/types";
import { JsonLd, profileJsonLd } from "@/components/JsonLd";
import { SITE_URL, bcp47 } from "@/lib/site";
import { CopyBadge } from "@/components/CopyBadge";
import { MaterialCardPanel } from "@/components/MaterialCardPanel";
import { ProfileShare } from "@/components/ProfileShare";
import { FloatingCommentBubbles } from "@/components/FloatingCommentBubbles";
import { TierAvatarFrame } from "@/components/TierAvatarFrame";
import { ImpactOrbit } from "@/components/ImpactOrbit";
import { DimensionStarChart } from "@/components/DimensionStarChart";
import { ScoreBreakdown, ScoreBreakdownSummary } from "@/components/ScoreBreakdown";
import { tierFor } from "@/lib/score-presentation";
import { roundHalfEven } from "@/lib/score";
import { DIMENSIONS } from "@/lib/dimensions";
import { beatPercent } from "@/lib/percentile";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import type { RealmId } from "@/lib/realm";
import { normLang } from "@/lib/lang";
import { tagsForLocale } from "@/lib/roast-tags";
import { scoreRedFlagLabel } from "@/lib/score-red-flags";
import { RescanButton } from "@/components/RescanButton";
import { StaleScanHint } from "@/components/StaleScanHint";
import { AutoReroast } from "@/components/AutoReroast";
import { StaleScoreRescan } from "@/components/StaleScoreRescan";
import { needsScoreVersionUpgrade } from "@/lib/score-version";
import { BadgeReferralBanner } from "@/components/BadgeReferralBanner";
import { RepoCardLink } from "@/components/RepoCardLink";
import { ProfileLandingBeacon } from "@/components/ProfileLandingBeacon";
import { ChallengeCta } from "@/components/ChallengeCta";
import { FollowButton } from "@/components/FollowButton";
import { FacetRankLink } from "@/components/FacetRankLink";
import { CommonProjects } from "@/components/CommonProjects";
import { ExplorationBeacon } from "@/components/ExplorationBeacon";
import { rankProfileWorks } from "@/lib/profile-work";
import { ROAST_CACHE_VERSION } from "@/lib/cache-version";
import { LEGACY_READ_FALLBACK } from "@/lib/release-versions";
import {
  ProfileArtifactStatus,
  resolveProfileArtifactState,
} from "@/app/[locale]/u/[username]/ProfileArtifactStatus";
import type { ReactNode } from "react";
import {
  classifyLandingSource,
  isGithubReferer,
  type LiveProfileScan,
  type ProfileComments,
  type ProfilePresentation,
} from "@/lib/pages/profile";
import type { Translator } from "@/lib/translator";

/**
 * The full /u/[username] profile, shared by the Next app and apps/web (see
 * BlogViews). Request-scoped facts arrive as props (the viewer, Referer,
 * comments, the roast-stream decision made against the server clock), and the
 * reactions block is a slot: Next streams it in Suspense, the island renders it
 * from preloaded state.
 */
export function ProfileView({
  locale,
  presentation,
  isAdvxCampaign,
  fromHome,
  refParam,
  referer,
  viewerLogin,
  comments,
  staleReroast,
  shouldStreamRoast,
  liveScan,
  reactions,
  t,
  tDim,
  tTier,
  tRealm,
}: {
  locale: string;
  presentation: ProfilePresentation;
  isAdvxCampaign: boolean;
  fromHome: boolean;
  refParam: string | string[] | undefined;
  referer: string | null;
  viewerLogin: string | null;
  comments: ProfileComments;
  staleReroast: boolean;
  shouldStreamRoast: boolean;
  liveScan: LiveProfileScan;
  reactions: ReactNode;
  /** "detail" namespace. */
  t: Translator;
  /** "dimensions" namespace. */
  tDim: Translator;
  /** "tiers" namespace (legacy bridge → realm names). */
  tTier: Translator;
  /** "realms" namespace. */
  tRealm: Translator;
}) {
  const d = presentation.detail;
  const realm = realmForScore(d.final_score);
  const realmVars = realmCssVars(realm, "dark");
  const style = tierStyle(d.tier); // kept for a few legacy chip paths during migration
  const tierKey = TIER_KEY[d.tier];
  const realmName = tRealm(`${realm.id}.name`);
  const realmBlurb = tRealm(`${realm.id}.blurb`);
  const lang = normLang(locale);
  // English visitors read the English-cached roast; fall back to the empty state
  // (not the Chinese report) so the page never mixes languages.
  const roast = lang === "en" ? d.roast_en : d.roast;
  // The bilingual one-liner is generated in one call, so it's available in the
  // visitor's language even when the full report exists only in the other one.
  // Empty for legacy rows — those still carry the one-liner inline in `roast`.
  const roastLine = lang === "en" ? d.roast_line.en : d.roast_line.zh;
  const legacyReadFallback = d.legacy_read_fallback;
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
  // Stale-while-revalidate: a score from an older scoring release offers a
  // manual 重新评测 and, for real visitors, an automatic background one.
  const autoRescan =
    artifactState === "stale-score" &&
    needsScoreVersionUpgrade({
      scoreVersion: d.score_version,
      sourceCollectionVersion: d.score_source_collection_version,
      sourceSnapshotHash: d.score_source_snapshot_hash,
    });
  // Current score, but no report on the current roast release in this
  // language (a score change cleared it, or the roast release moved on):
  // regenerate on view instead of showing the "not archived" empty state.
  const reroastPending = artifactState === "report-pending" && !legacyReadFallback && !roast;
  const staleRoast = (lang === "en" ? d.stale_roast_en : d.stale_roast) ?? null;
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
  const similar = presentation?.similar ?? [];
  const snap = presentation?.snapshot ?? null;
  const rank = presentation?.rank ?? null;
  const facetRank = presentation?.facetRank ?? null;
  const commonProjects = presentation?.common_projects ?? [];
  // Inline re-detect is self-service: only the signed-in owner sees it on their
  // own profile. GitHub handles are case-insensitive, so compare normalized.
  const isOwner =
    viewerLogin?.toLowerCase() === d.username.toLowerCase();
  // Badge-landing hook: a visitor arriving from a GitHub README badge (Referer
  // github.com) or an explicit ?ref=badge, looking at someone else's page, gets
  // nudged into a PK against the owner. Reading headers is free here — the page
  // is already force-dynamic. Suppressed for the owner (can't duel yourself).

  const fromBadgeRef = refParam === "badge";
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
  const promo = nextRealm(d.final_score);
  const promoGap = promo ? (promo.threshold - d.final_score).toFixed(2) : null;
  const promoTierName = promo ? tRealm(`${promo.realm.id}.name`) : null;
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
  const dimensionLabels = Object.fromEntries(
    DIMENSIONS.map((key) => [key, tDim(key)]),
  ) as Record<(typeof DIMENSIONS)[number], string>;
  const inferredBaseScore = roundHalfEven(
    Object.values(d.sub_scores).reduce((sum, value) => sum + value, 0),
    1,
  );
  const inferredPenalty = Math.max(0, roundHalfEven(inferredBaseScore - d.final_score, 2));
  const scoreBreakdown = d.score_breakdown ?? {
    base_score: inferredBaseScore,
    total_penalty: inferredPenalty,
    applied_penalty: inferredPenalty,
    red_flags: [],
    complete: false,
  };
  const scoreBreakdownCopy = {
    base: t("scoreBase"),
    adjustment: t("scoreAdjustment"),
    inferredAdjustment: t("scoreInferredAdjustment"),
    final: t("scoreFinal"),
    heading: t("scoreBreakdownHeading"),
    note: t("scoreBreakdownNote"),
    riskHeading: t("scoreRiskHeading", {
      count: (scoreBreakdown.risk_assessment?.signals ?? scoreBreakdown.red_flags).length,
    }),
    unavailable: t("scoreRiskUnavailable"),
    capNote: t("scoreAdjustmentLimited", {
      total: scoreBreakdown.total_penalty.toFixed(2),
      applied: scoreBreakdown.applied_penalty.toFixed(2),
    }),
    more: t("scoreRiskMore", { count: Math.max(0, scoreBreakdown.red_flags.length - 3) }),
    riskStatus: t("scoreRiskStatus"),
    riskScore: t("scoreRiskScore"),
    riskFootprintNote: t("scoreRiskFootprintNote"),
    riskNoPenalty: t("scoreRiskNoPenalty"),
    riskNotesHeading: t("scoreRiskNotes", {
      count: (scoreBreakdown.risk_notes ?? []).length,
    }),
  };

  // Evidence blocks (only when a sedimented snapshot exists).
  const impactRepos = snap
    ? [...snap.impact_repos].toSorted((a, b) => b.stars - a.stars).slice(0, 6)
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
  const organizations = snap?.organizations ?? [];
  // Repo cards route into their internal project page (reclaiming the click that
  // otherwise leaks to github.com) — but only where a project page has content,
  // i.e. the repo exists as a first-class `repos` row. One indexed lookup over
  // both representative and impact repos; failure → empty set → all
  // cards keep their external GitHub links (pre-Phase-B behavior).
  const existingRepoKeys = new Set(presentation?.existing_repo_keys ?? []);
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
                {tag && <div className="truncate text-[11px] profile-realm-accent-text">#{tag}</div>}
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
    <main
      data-realm={realm.id}
      data-profile-realm-theme=""
      className="profile-realm-theme relative isolate flex w-full flex-1 justify-center px-5 py-14 sm:py-20"
      style={realmVars}
    >
      <FloatingCommentBubbles
        key={d.username}
        lang={lang}
        profileUsername={d.username}
        initialComments={comments}
      />
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
            className="profile-realm-link text-sm text-zinc-400"
          >
            ← 返回
          </Link>
        ) : (
          <Link
            href="/leaderboard"
            prefetch={false}
            className="profile-realm-link text-sm text-zinc-400"
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
        data-profile-score-card
        data-realm={realm.id}
        className={`animate-pop flex flex-col items-center overflow-visible text-center ${
          isAdvxCampaign
            ? "bg-transparent p-0"
            : "rounded-2xl border border-white/10 bg-white/[0.05] p-6"
        }`}
        style={
          isAdvxCampaign
            ? realmVars
            : {
                ...realmVars,
                boxShadow: `0 0 80px -20px ${realm.colors.glow}`,
                borderColor: `color-mix(in srgb, ${realm.colors.ring} 12%, transparent)`,
                borderWidth: 1,
                borderStyle: "solid",
              }
        }
      >
        <h1 className="max-w-full">
          <a
            href={d.profile_url ?? `https://github.com/${d.username}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-block max-w-full break-all text-xl font-black leading-tight ${
              isAdvxCampaign ? "" : "rounded-full bg-black/35 px-4 py-1.5 hover:bg-black/45"
            }`}
            style={{
              color: "var(--realm-fg)",
              ...(isAdvxCampaign
                ? {}
                : {
                    boxShadow: `0 0 28px -10px ${realm.colors.glow}`,
                    outline: `1px solid color-mix(in srgb, ${realm.colors.ring} 50%, transparent)`,
                  }),
            }}
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
        {impactRepos.length > 0 ? (
          <ImpactOrbit
            repos={impactRepos}
            tier={d.tier}
            score={d.final_score}
            locale={bcp47(locale)}
            commitsLabel={t("commits")}
            prsLabel={t("prs")}
            sectionTitle={t("impactHeading")}
            className="mt-5"
          >
            <TierAvatarFrame
              username={d.username}
              avatarUrl={d.avatar_url}
              score={d.final_score}
              tier={d.tier}
              realm={realm}
              realmName={realmName}
              size="lg"
            />
          </ImpactOrbit>
        ) : (
          <TierAvatarFrame
            username={d.username}
            avatarUrl={d.avatar_url}
            score={d.final_score}
            tier={d.tier}
            realm={realm}
            realmName={realmName}
            size="lg"
            className="mt-5"
          />
        )}
        <div data-profile-score-value className="mt-1">
          <AdventurerLevel
            score={d.final_score}
            realm={realm}
            caption={t("adventurerLevel")}
            size="lg"
            lang={lang === "en" ? "en" : "zh"}
          />
        </div>
        {fromHome && <StaleScanHint username={d.username} />}
        <ScoreBreakdownSummary breakdown={scoreBreakdown} copy={scoreBreakdownCopy} />
        <div className="mt-2">
          <RealmChip realm={realm} name={realmName} />
        </div>
        <div className="mt-1 text-sm font-medium text-zinc-400">
          {realmBlurb}
        </div>
        {shouldStreamRoast || reroastPending ? (
          <p className="mt-2 text-sm text-zinc-400">{t("scoreReadyHint")}</p>
        ) : null}
        {isOwner && (
          <RescanButton
            username={d.username}
            scannedAt={d.scanned_at}
            className="mt-4 w-full max-w-xs"
          />
        )}

        {isAdvxCampaign && roastLine && (
          <p
            data-advx-mobile-roast
            className="mt-4 w-full border-s-2 ps-4 text-start text-[0.95rem] leading-relaxed text-zinc-100 lg:hidden"
            style={{ borderColor: "color-mix(in srgb, var(--realm-fg) 55%, transparent)" }}
          >
            🔥 {roastLine}
          </p>
        )}

        {(() => {
          const shown = tagsForLocale(d.tags, locale);
          if (shown.length === 0) return null;
          return (
            <div
              className="mt-4 flex max-w-md flex-wrap justify-center gap-2"
              aria-label="tags"
            >
              {shown.map((tag, i) => (
                <span
                  key={`${tag}-${i}`}
                  className="profile-realm-chip rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide"
                >
                  #{tag}
                </span>
              ))}
            </div>
          );
        })()}

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
        action={
          artifactState === "stale-score" ? (
            <StaleScoreRescan username={d.username} auto={autoRescan} />
          ) : undefined
        }
      />

      {/* My standing — concrete rank, "beat %", a milestone hint to the next
          tier, and an inline re-detect button to refresh the score. */}
      <div
        data-realm={realm.id}
        className={
          isAdvxCampaign
            ? `mt-5 bg-transparent p-0 text-center ${advxDivider}`
            : "mt-5 rounded-2xl border p-4 text-center"
        }
        style={
          isAdvxCampaign
            ? undefined
            : {
                borderColor: "color-mix(in srgb, var(--realm-ring) 35%, transparent)",
                backgroundColor: "color-mix(in srgb, var(--realm-glow) 55%, transparent)",
                ...realmVars,
              }
        }
      >
        {!isAdvxCampaign && (
          <div
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--realm-fg)" }}
          >
            {t("rankTitle")}
          </div>
        )}
        {rank ? (
          <>
            <div className="mt-1 text-4xl font-black tabular-nums" style={{ color: "var(--realm-fg)" }}>
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

      {reactions}

        <ProfileShare
          username={d.username}
          name={d.display_name}
          avatarUrl={d.avatar_url}
          score={d.final_score}
          tier={d.tier}
          tierLabel={realmBlurb}
          beat={beat}
          tags={d.tags}
        />
        <CopyBadge
          baseUrl={SITE_URL}
          username={d.username}
          version={d.scanned_at}
          surface={isAdvxCampaign ? "profile_advx" : "profile"}
        />
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

      {/* Dimension breakdown */}
      <section className={dimensionSectionClass}>
        <h2 className="mb-4 text-base font-bold text-zinc-200">{t("dimensionsHeading")}</h2>
        <DimensionStarChart
          scores={d.sub_scores}
          labels={dimensionLabels}
          score={d.final_score}
          tier={d.tier}
          compact={isAdvxCampaign}
        />
        <ScoreBreakdown
          breakdown={scoreBreakdown}
          finalScore={d.final_score}
          copy={scoreBreakdownCopy}
          flagLabel={(flag) => scoreRedFlagLabel(flag, lang)}
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
                    <span className="profile-realm-accent-text shrink-0 text-xs tabular-nums">
                      ⭐ {nf.format(work.stars)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                    {work.prs ? <span>{nf.format(work.prs)} {t("prs")}</span> : null}
                    {work.commits ? <span>{nf.format(work.commits)} {t("commits")}</span> : null}
                    {work.orgContextRepo ? <span>↔ {work.orgContextRepo}</span> : null}
                    {work.language ? <span>{work.language}</span> : null}
                    {work.attributionShare !== undefined ? <span className="whitespace-nowrap text-zinc-400">{t("coCreatorShare", {share: work.attributionShare>0 && work.attributionShare<0.001 ? "<0.1" : nf.format(Math.round(work.attributionShare*1000)/10)})}</span> : null}
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
          {impactRepos.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs font-medium text-zinc-400 hover:text-zinc-200">
                {t("impactDisclosure", { count: impactRepos.length })}
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                {impactRepos.map((r) => {
                  const key = r.repo.toLowerCase();
                  const internal = existingRepoKeys.has(key);
                  const cardClass = "flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]";
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
            </details>
          )}
        </section>
      )}

      {representativeWorks.length === 0 && impactRepos.length > 0 && (
        <section className={contentSectionClass}>
          <details>
            <summary className="cursor-pointer text-xs font-medium text-zinc-400 hover:text-zinc-200">
              {t("impactDisclosure", { count: impactRepos.length })}
            </summary>
            <div className="mt-2 flex flex-col gap-2">
                {impactRepos.map((r) => {
                  const key = r.repo.toLowerCase();
                  const internal = existingRepoKeys.has(key);
                  const cardClass = "flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]";
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
          </details>
        </section>
      )}

      <CommonProjects projects={commonProjects} flat={isAdvxCampaign} />

      {similarSection}

      {/* Full roast report */}
      <section
        className={
          isAdvxCampaign
            ? `mt-6 bg-transparent p-0 ${advxDivider}`
            : "mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-7"
        }
      >
        {/* LLM content only exists in zh/en; a ja/ko visitor reads the English
            side, so tell them why the report language differs from the UI. */}
        {lang !== locale && (roast || roastLine) && (
          <p className="mb-3 text-xs text-zinc-500">{t("reportLangNotice")}</p>
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
              // Profile popup disabled 2026-10-28 (owner request); keep code for possible re-enable
              openModalOnMount={false}
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
              {/* Profile popup disabled 2026-10-28 (owner request); keep code for possible re-enable
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
              */}
              <RoastReport markdown={roast} tier={d.tier} score={d.final_score} realmName={realmName} />
            </>
          )
        ) : shouldStreamRoast ? (
          <LiveRoast
            username={d.username}
            scan={liveScan}
            // Profile popup disabled 2026-10-28 (owner request); keep code for possible re-enable
            openModalOnMount={false}
            fallbackMeta={fromHome ? (revealMeta ?? undefined) : undefined}
            profileName={d.display_name}
            profileAvatarUrl={d.avatar_url}
            orgs={organizations}
            advx={isAdvxCampaign}
            materialVersion={d.scanned_at}
          />
        ) : reroastPending ? (
          <AutoReroast
            username={d.username}
            lang={lang}
            staleReport={
              staleRoast ? (
                <RoastReport markdown={staleRoast} tier={d.tier} score={d.final_score} realmName={realmName} />
              ) : null
            }
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
