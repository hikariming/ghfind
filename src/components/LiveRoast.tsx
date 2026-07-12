"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "@/i18n/navigation";
import { readSessionScan, stripRoastingParam } from "@/lib/home-handoff";
import { splitReport } from "@/lib/report";
import { normLang } from "@/lib/lang";
import { consumeRoastStream } from "@/lib/roast-stream";
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
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const router = useRouter();
  const started = useRef(false);
  // Popup lifecycle: `closedRef` remembers a user dismissal (never reopen on
  // late frames); `doneRef` gates the deferred page refresh — closing mid-stream
  // must NOT refresh, or the re-render would unmount this component and kill
  // the in-flight generation.
  const closedRef = useRef(false);
  const doneRef = useRef(false);

  const [thinking, setThinking] = useState("");
  const [report, setReport] = useState("");
  const [meta, setMeta] = useState<RoastMeta | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // The stream finished (success or failure) — the popup's 辣评 slot stops
  // showing the warming-up spinner once this flips.
  const [settled, setSettled] = useState(false);
  // The popup's current content. Seeded at mount for homepage handoffs; for
  // other visitors it opens only after a fresh LLM generation completes.
  const [modalMeta, setModalMeta] = useState<RoastMeta | null>(() =>
    openModalOnMount ? (fallbackMeta ?? null) : null,
  );
  // Handoff fallback: on a hard reload the caller may have no scan prop, but the
  // homepage stash can still be in sessionStorage. Resolved once at mount.
  const [sessionScan] = useState(() => (scan ? null : readSessionScan(username)));

  // Refresh the server page once (a one-shot guard prevents a refresh loop if the
  // row still isn't visible afterward). For a fresh roast this is deferred until
  // the popup closes — refreshing immediately would swap the shell for the full
  // profile and unmount the popup mid-view. The `?roasting=1` handoff marker is
  // spent here, BEFORE the refresh — otherwise the re-rendered server page would
  // still see it and pop the reveal modal again right after the user closed it.
  const refreshOnce = useCallback(() => {
    stripRoastingParam();
    const key = `liveRoastRefreshed:${username.toLowerCase()}`;
    if (typeof sessionStorage !== "undefined" && !sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, "1");
      router.refresh();
    }
  }, [username, router]);

  useEffect(() => {
    if (started.current) return; // guard against StrictMode double-invoke
    started.current = true;
    // A mount-time popup consumes the handoff marker right away: the popup has
    // already delivered the moment, so reloads/back-nav must not repeat it (or
    // re-trigger a stale regeneration).
    if (openModalOnMount) stripRoastingParam();
    // Failure downgrade: with fallback content the old report renders (and the
    // already-open popup keeps its stored content) instead of an error line —
    // the caller only passes it when a stored roast exists to fall back to.
    const fail = (key: string) => {
      doneRef.current = true;
      setSettled(true);
      if (fallbackReport !== undefined && fallbackMeta) {
        setMeta(fallbackMeta);
        setReport(fallbackReport);
        if (!closedRef.current) setModalMeta(fallbackMeta);
      } else {
        setErrorKey(key);
      }
    };
    (async () => {
      try {
        const res = await fetch("/api/roast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
          onThinking: setThinking,
          onMeta: (m) => {
            latestMeta = m;
            setMeta(m);
            // Mount-time popup: swap the seeded (old/deterministic) card for the
            // real result the moment the meta frame lands — unless dismissed.
            if (openModalOnMount && !closedRef.current) setModalMeta(m);
          },
          onReport: setReport,
          onError: (data) => fail(mapError(data?.error)),
        });
        if (errored) return;

        doneRef.current = true;
        setSettled(true);
        if (closedRef.current) {
          // Popup already dismissed mid-stream — refresh into the full profile.
          refreshOnce();
        } else if ((fresh || openModalOnMount) && latestMeta) {
          // Fresh generation (or a handoff popup that's already open): show the
          // final meta and hold the page refresh until the user closes it.
          setModalMeta(latestMeta);
        } else {
          // Cached replay for a non-handoff visitor → no popup, refresh now.
          refreshOnce();
        }
      } catch {
        fail("liveError");
      }
    })();
  }, [username, scan, sessionScan, locale, refresh, openModalOnMount, fallbackReport, fallbackMeta, refreshOnce]);

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
    />
  ) : null;

  if (errorKey) {
    return (
      <>
        {modal}
        <p className="text-sm text-zinc-400">
          {t(errorKey)}{" "}
          <Link href="/" className="text-orange-400 hover:underline">
            {t("liveGoHome")}
          </Link>
        </p>
      </>
    );
  }

  const { body: reportBody, roast: inlineRoast } = splitReport(report);
  const line = pickLine(meta?.roast_line, locale) || inlineRoast;
  const tags = meta?.tags;

  return (
    <>
      {modal}
      {line ? (
        <p className="mb-4 rounded-xl border border-orange-500/30 bg-orange-500/[0.08] p-4 text-[0.95rem] leading-relaxed text-zinc-100">
          🔥 {line}
        </p>
      ) : (
        <div className="mb-4 flex flex-col items-center gap-3 py-4 text-center">
          <div className="flex gap-1.5">
            <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400 [animation-delay:-0.3s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400 [animation-delay:-0.15s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400" />
          </div>
          <div className="text-sm text-zinc-400 tabular-nums">
            {thinking || t("livePending")}
          </div>
        </div>
      )}

      {tags && (tags.zh.length > 0 || tags.en.length > 0) && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {tagsList(tags).map((tag, i) => (
            <span
              key={`${tag}-${i}`}
              className="rounded-full border border-orange-400/30 bg-orange-500/10 px-2.5 py-0.5 text-xs font-medium text-orange-200"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {reportBody && (
        <div className={`report text-[0.95rem] text-zinc-200 ${report ? "caret" : ""}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportBody}</ReactMarkdown>
        </div>
      )}
    </>
  );
}

/** Map a server error code to a `detail` message key. */
function mapError(code: string | undefined): string {
  if (code === "rate_limited") return "liveRateLimited";
  if (code === "missing_scan") return "liveExpired";
  return "liveError";
}

function pickLine(line: RoastLine | undefined, locale: string): string {
  if (!line) return "";
  return normLang(locale) === "en" ? line.en : line.zh;
}

function tagsList(tags: Tags): string[] {
  return [...tags.zh, ...tags.en];
}
