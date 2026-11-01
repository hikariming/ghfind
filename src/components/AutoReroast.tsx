"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { History, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AUTO_REROAST_TRIGGER, autoReroastArmedKey, autoReroastSessionKey } from "@/lib/auto-reroast";
import type { Lang } from "@/lib/lang";
import { StaleScoreRescan } from "./StaleScoreRescan";

/**
 * Roast section for a profile whose score is current but whose report in this
 * language is not on the current roast release (see src/lib/auto-reroast.ts).
 *
 * Never the "not archived" empty state: it shows the previous-release report
 * labelled 旧版锐评 (or a skeleton when none survives a score change), asks the
 * server to regenerate it after a real interaction, polls the async job and
 * refreshes the page once the new report is persisted. Deferrals, failures and
 * a slow job keep that non-empty state plus the manual 重新评测 action.
 */

type Phase = "idle" | "working" | "pending" | "failed" | "slow";

const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart", "wheel"] as const;
const POLL_FAST_MS = 4_000;
const POLL_SLOW_MS = 10_000;
const POLL_FAST_WINDOW_MS = 60_000;
/** Stop polling after this; the job may still finish (cron), the page says so. */
const AUTO_REROAST_POLL_LIMIT_MS = 12 * 60_000;

function claimAttempt(username: string, lang: Lang): boolean {
  try {
    const key = autoReroastSessionKey(username, lang);
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

function takeArmed(username: string): boolean {
  try {
    const key = autoReroastArmedKey(username);
    const armed = window.sessionStorage.getItem(key) !== null;
    if (armed) window.sessionStorage.removeItem(key);
    return armed;
  } catch {
    return false;
  }
}

type JobState = "none" | "queued" | "running" | "done" | "failed";

async function readState(res: Response): Promise<JobState> {
  try {
    const body = (await res.json()) as { state?: unknown };
    const s = body.state;
    return s === "queued" || s === "running" || s === "done" || s === "failed" ? s : "none";
  } catch {
    return "none";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AutoReroast({
  username,
  lang,
  staleReport,
}: {
  username: string;
  lang: Lang;
  /** Previous-release report, already rendered; null when none survives. */
  staleReport: ReactNode | null;
}) {
  const t = useTranslations("detail");
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const startedRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const statusUrl = `/api/roast/auto?username=${encodeURIComponent(username)}&lang=${lang}`;

  const poll = useCallback(
    async (location: string) => {
      const startedAt = Date.now();
      while (aliveRef.current) {
        const elapsed = Date.now() - startedAt;
        if (elapsed > AUTO_REROAST_POLL_LIMIT_MS) {
          setPhase("slow");
          return;
        }
        await sleep(elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
        if (!aliveRef.current) return;
        let state: JobState = "none";
        try {
          const res = await fetch(location, { cache: "no-store" });
          if (!res.ok) continue;
          state = await readState(res);
        } catch {
          continue; // transient; keep polling until the limit
        }
        if (state === "done") {
          router.refresh();
          return;
        }
        if (state === "failed" || state === "none") {
          setPhase("failed");
          return;
        }
      }
    },
    [router],
  );

  const start = useCallback(async () => {
    setPhase("working");
    try {
      const res = await fetch("/api/roast/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, lang, trigger: AUTO_REROAST_TRIGGER }),
      });
      const state = res.ok || res.status === 202 ? await readState(res) : "none";
      if (state === "done") {
        router.refresh();
        return;
      }
      if (res.status === 202 && (state === "queued" || state === "running")) {
        await poll(res.headers.get("Location") || statusUrl);
        return;
      }
      // Deferred (cooldown, budget, kill switch, not eligible) — not an error.
      setPhase("pending");
    } catch {
      setPhase("pending");
    }
  }, [username, lang, router, poll, statusUrl]);

  // Join a job another visitor already started (read-only), else start one on
  // a real interaction — immediately when the auto score rescan armed it.
  useEffect(() => {
    if (startedRef.current || typeof window === "undefined" || navigator.webdriver) return;
    let detached = false;
    const begin = () => {
      if (startedRef.current || document.visibilityState !== "visible") return;
      startedRef.current = true;
      detach();
      if (claimAttempt(username, lang)) void start();
      else setPhase("pending");
    };
    const detach = () => {
      if (detached) return;
      detached = true;
      for (const name of INTERACTION_EVENTS) window.removeEventListener(name, begin);
    };
    if (takeArmed(username)) {
      begin();
      return detach;
    }
    for (const name of INTERACTION_EVENTS) window.addEventListener(name, begin, { passive: true });
    return detach;
  }, [username, lang, start]);

  const working = phase === "working";
  const message = working
    ? t("roastRegenerating")
    : phase === "failed"
      ? t("roastRegenerateFailed")
      : phase === "slow"
        ? t("roastRegenerateSlow")
        : t("roastRegeneratePending");

  return (
    <div data-auto-reroast={phase} className="space-y-3">
      <div className="rounded-lg border border-orange-500/20 bg-orange-500/[0.05] px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {staleReport && (
            <Badge className="gap-1 bg-amber-500/15 text-amber-200">
              <History aria-hidden className="h-3 w-3" />
              {t("roastStaleLabel")}
            </Badge>
          )}
          <span
            role="status"
            className={`inline-flex items-center gap-1 text-xs ${phase === "failed" ? "text-rose-300" : "text-zinc-300"}`}
          >
            {working && <LoaderCircle aria-hidden className="h-3 w-3 animate-spin" />}
            {message}
          </span>
        </div>
        {staleReport && <p className="mt-1 text-[11px] text-zinc-500">{t("roastStaleHint")}</p>}
        {!working && <StaleScoreRescan username={username} auto={false} />}
      </div>
      {staleReport ? (
        <div className={working ? "opacity-60 transition-opacity" : "opacity-80"}>{staleReport}</div>
      ) : working ? (
        <div aria-hidden className="space-y-2">
          <Skeleton className="h-3 w-11/12 bg-white/10" />
          <Skeleton className="h-3 w-10/12 bg-white/10" />
          <Skeleton className="h-3 w-8/12 bg-white/10" />
        </div>
      ) : null}
    </div>
  );
}
