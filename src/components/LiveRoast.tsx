"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { RoastReport } from "./RoastReport";
import { RoastProgressCard } from "./RoastProgressCard";
import { useRoastProgress } from "./useRoastProgress";
import { Link } from "@/i18n/navigation";
import { consumeRoastingHandoff, readSessionScan, stripRoastingParam } from "@/lib/home-handoff";
import { splitReport } from "@/lib/report";
import { normLang } from "@/lib/lang";
import { tagsForLocale } from "@/lib/roast-tags";
import { consumeRoastStream } from "@/lib/roast-stream";
import { isRoastClientTimeout, roastClientSignal } from "@/lib/roast-client-timeout";
import { readRoastStart } from "@/lib/roast-progress";
import type { RoastLine, RoastMeta, ScanResult, Tags } from "@/lib/types";
import { RoastResultModal } from "./RoastResultModal";

/**
 * Streams a live roast on the profile page for a username that has been scanned
 * (its scan is in the server-side cache) but not yet roasted — so the visitor
 * sees the report write itself in place instead of waiting on the homepage.
 * Renders the inner roast-section content only (the heading/section wrapper is
 * the caller's). On completion it refreshes the server-rendered page once, so
 * the freshly persisted profile (rank, reactions, badge) replaces this shell.
 */
// Profile popup disabled 2026-10-28 (owner request); keep code for possible re-enable
const PROFILE_POPUP_ENABLED = false;

export function LiveRoast({
  username,
  scan,
  refresh = false,
  openModalOnMount = false,
  fallbackReport,
  fallbackMeta,
  profileName,
  profileAvatarUrl,
  orgs,
  advx = false,
  materialVersion,
}: {
  username: string;
  /** Fresh scan from the homepage handoff. Sent in the request body so the roast
   * works even without a server-side scan cache; the route still prefers its own
   * cached scan when present (the client can't inflate the score). */
  scan?: ScanResult | null;
  /** Ask the route to regenerate instead of replaying. The server re-validates
   * staleness, so this is safe to set whenever the caller believes the stored
   * roast is >24h old. */
  refresh?: boolean;
  /** Homepage handoff: open the result popup IMMEDIATELY at mount, seeded with
   * `fallbackMeta` (stored roast, or the deterministic scan score), then update
   * it in place as the stream's meta arrives. The share moment must not wait on
   * the LLM. */
  openModalOnMount?: boolean;
  /** Stored report body / meta: seed for the mount-time popup, and the content
   * to fall back to when generation fails or is rate-limited (old report renders
   * instead of an error line, so the popup keeps something to show). */
  fallbackReport?: string;
  fallbackMeta?: RoastMeta;
  /** Display identity for the popup's share card when no scan is at hand. */
  profileName?: string | null;
  profileAvatarUrl?: string | null;
  /** Org handles forwarded to the popup's flex card. */
  orgs?: string[];
  /** Use the ADVX material-card treatment in the result popup. */
  advx?: boolean;
  materialVersion?: string | number;
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const router = useRouter();
  const started = useRef(false);
  const generationRef = useRef(0);
  const openedHandoffPopupRef = useRef(false);
  // Popup lifecycle: `closedRef` remembers a user dismissal (never reopen on
  // late frames); `doneRef` gates the deferred page refresh — closing mid-stream
  // must NOT refresh, or the re-render would unmount this component and kill
  // the in-flight generation.
  const closedRef = useRef(false);
  const doneRef = useRef(false);
  const refreshedRef = useRef(false);

  const [report, setReport] = useState("");
  const [meta, setMeta] = useState<RoastMeta | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // The stream finished (success or failure) — the popup's 辣评 slot stops
  // showing the warming-up spinner once this flips.
  const [settled, setSettled] = useState(false);
  // The popup's current content. Seeded at mount for homepage handoffs; for
  // other visitors it opens only after a fresh LLM generation completes.
  const [modalMeta, setModalMeta] = useState<RoastMeta | null>(null);
  // Handoff fallback: on a hard reload the caller may have no scan prop, but the
  // homepage stash can still be in sessionStorage. Resolved once at mount.
  const [sessionScan] = useState(() => (scan ? null : readSessionScan(username)));
  const [attempt, setAttempt] = useState(0);
  const [awaitingRoast, setAwaitingRoast] = useState(true);
  const [resumeProgress] = useState(() => readRoastStart(username, locale) != null);
  const progress = useRoastProgress(awaitingRoast, username, locale, { resume: resumeProgress });
  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  });

  // Refresh the server page once (a one-shot guard prevents a refresh loop if the
  // row still isn't visible afterward). For a fresh roast this is deferred until
  // the popup closes — refreshing immediately would swap the shell for the full
  // profile and unmount the popup mid-view. The `?roasting=1` handoff marker is
  // spent here, BEFORE the refresh — otherwise the re-rendered server page would
  // still see it and pop the reveal modal again right after the user closed it.
  const refreshOnce = useCallback(() => {
    stripRoastingParam();
    if (!refreshedRef.current) {
      refreshedRef.current = true;
      router.refresh();
    }
  }, [router]);

  useEffect(() => {
    if (started.current) return; // guard against StrictMode double-invoke
    started.current = true;
    const generation = generationRef.current;
    // Spend the homepage handoff exactly once for this history entry. This
    // guards a remounted profile subtree from opening a second result popup
    // while its server-rendered props still say `openModalOnMount`.
    openedHandoffPopupRef.current =
      PROFILE_POPUP_ENABLED && openModalOnMount && consumeRoastingHandoff();
    if (openedHandoffPopupRef.current && fallbackMeta) setModalMeta(fallbackMeta);
    // Failure downgrade: with fallback content the old report renders (and the
    // already-open popup keeps its stored content) instead of an error line —
    // the caller only passes it when a stored roast exists to fall back to.
    const fail = (
      key: string,
      streamFallback?: { report?: string; meta?: RoastMeta },
    ) => {
      if (generation !== generationRef.current) return;
      doneRef.current = true;
      setAwaitingRoast(false);
      setSettled(true);
      const reportFallback = streamFallback?.report ?? fallbackReport;
      const metaFallback = streamFallback?.meta ?? fallbackMeta;
      if (reportFallback !== undefined && metaFallback) {
        setMeta(metaFallback);
        setReport(reportFallback);
        if (!closedRef.current) setModalMeta(metaFallback);
      } else {
        setErrorKey(key);
      }
    };
    (async () => {
      try {
        const res = await fetch("/api/roast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: roastClientSignal(),
          // Send the handed-off scan when present (works without a server cache);
          // the route falls back to its own cached scan otherwise. byoKey is
          // always null here (BYO roasts stay on the home page, since they
          // persist nothing for the profile to refresh into).
          body: JSON.stringify({
            username,
            scan: scan ?? sessionScan ?? undefined,
            byoKey: null,
            lang: locale,
            refresh: refresh || undefined,
          }),
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          fail(mapError(data?.error));
          return;
        }

        let latestMeta: RoastMeta | null = null;
        const { errored, fresh } = await consumeRoastStream(res, {
          onGenerator: (generator) => progressRef.current.setGenerator(generator),
          onStarted: (startedAt) => progressRef.current.noteStarted(startedAt),
          onThinking: (label) => progressRef.current.noteThinking(label),
          onMeta: (m) => {
            latestMeta = m;
            if (generation === generationRef.current) progressRef.current.markComplete();
            setMeta(m);
            // Mount-time popup: swap the seeded (old/deterministic) card for the
            // real result the moment the meta frame lands — unless dismissed.
            if (openedHandoffPopupRef.current && !closedRef.current) setModalMeta(m);
          },
          onReport: (text) => {
            if (text.trim()) progressRef.current.markComplete();
            setReport(text);
          },
          onError: (data) => fail(mapError(data?.error), data?.fallback),
        });
        if (errored || generation !== generationRef.current) return;
        progressRef.current.markComplete();

        doneRef.current = true;
        setAwaitingRoast(false);
        setSettled(true);
        if (closedRef.current) {
          // Popup already dismissed mid-stream — refresh into the full profile.
          refreshOnce();
        } else if (
          PROFILE_POPUP_ENABLED &&
          ((fresh && !openModalOnMount) || openedHandoffPopupRef.current) &&
          latestMeta
        ) {
          // Fresh generation (or a handoff popup that's already open): show the
          // final meta and hold the page refresh until the user closes it.
          setModalMeta(latestMeta);
        } else {
          // Cached replay for a non-handoff visitor → no popup, refresh now.
          refreshOnce();
        }
      } catch (error) {
        fail(isRoastClientTimeout(error) ? "liveTimeout" : "liveError");
      }
    })();
  }, [username, scan, sessionScan, locale, refresh, openModalOnMount, fallbackReport, fallbackMeta, refreshOnce, attempt]);

  const effScan = scan ?? sessionScan;
  // The popup outlives an error: a mount-time popup seeded with scan data keeps
  // its flex card even when the stream fails (the error renders behind it).
  const modal = modalMeta ? (
    <RoastResultModal
      open
      onClose={() => {
        closedRef.current = true;
        setModalMeta(null);
        // Deferred refresh: only once the stream has finished — refreshing
        // mid-stream would unmount this component and abort the generation.
        if (doneRef.current) refreshOnce();
      }}
      username={username}
      name={profileName ?? effScan?.metrics.name ?? null}
      avatarUrl={
        profileAvatarUrl ?? effScan?.metrics.avatar_url ?? `https://github.com/${username}.png`
      }
      meta={modalMeta}
      orgs={orgs ?? effScan?.organizations ?? undefined}
      pendingLine={!settled}
      advx={advx}
      materialVersion={materialVersion}
    />
  ) : null;

  if (errorKey) {
    return (
      <>
        {modal}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-foreground/80">
          <p>{t(errorKey)}</p>
          <button
            type="button"
            className="mt-3 text-sm font-medium text-orange-400 hover:underline"
            onClick={() => {
              generationRef.current += 1;
              started.current = false;
              doneRef.current = false;
              progress.reset();
              setErrorKey(null);
              setReport("");
              setMeta(null);
              setSettled(false);
              setAwaitingRoast(true);
              setAttempt((n) => n + 1);
            }}
          >
            {t("liveRetry")}
          </button>
        </div>
      </>
    );
  }

  const { body: reportBody, roast: inlineRoast } = splitReport(report);
  const line = pickLine(meta?.roast_line, locale) || inlineRoast;
  const tags = meta?.tags;
  const stages = [t("roastStage1"), t("roastStage2"), t("roastStage3"), t("roastStage4"), t("roastStage5")];
  const stage = stages[Math.min(progress.stageIndex, stages.length - 1)] ?? stages[0];
  const waiting = awaitingRoast && !line && !reportBody;
  const showProgress = waiting || (progress.fading && !progress.hidden);

  return (
    <>
      {modal}
      {showProgress ? (
        <div className={progress.fading ? "mb-4 opacity-0 transition-opacity duration-300 motion-reduce:transition-none" : "opacity-100"}>
          <RoastProgressCard
            percent={progress.percent}
            title={t("roastProgressTitle")}
            stage={stage}
            liveStage={stage}
            score={scan?.scoring?.final_score ?? fallbackMeta?.final_score}
            tier={scan?.scoring?.tier ?? fallbackMeta?.tier}
          />
        </div>
      ) : null}
      {tagsForLocale(tags, locale).length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {tagsForLocale(tags, locale).map((tag, i) => (
            <span
              key={`${tag}-${i}`}
              className="rounded-full border border-zinc-500/25 bg-zinc-500/[0.08] px-2 py-0.5 text-[10px] font-medium tracking-wide text-zinc-400"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {reportBody && !waiting ? (
        <div className="roast-progress-reveal">
          <RoastReport markdown={reportBody} className={report ? "caret" : ""} tier={scan?.scoring?.tier ?? fallbackMeta?.tier} score={scan?.scoring?.final_score ?? fallbackMeta?.final_score} />
        </div>
      ) : null}
    </>
  );
}

/** Map a server error code to a `detail` message key. */
function mapError(code: string | undefined): string {
  if (code === "rate_limited") return "liveRateLimited";
  if (code === "missing_scan") return "liveExpired";
  if (code === "llm_quota") return "liveQuota";
  if (code === "roast_timeout") return "liveTimeout";
  return "liveError";
}

function pickLine(line: RoastLine | undefined, locale: string): string {
  if (!line) return "";
  return normLang(locale) === "en" ? line.en : line.zh;
}

