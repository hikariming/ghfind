"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AUTO_RESCAN_TRIGGER } from "@/lib/auto-rescan";
import { autoReroastArmedKey } from "@/lib/auto-reroast";
import { consumeRoastStream } from "@/lib/roast-stream";
import { isRoastClientTimeout, roastClientSignal } from "@/lib/roast-client-timeout";
import { completedScanPayload, readScanResponse } from "@/lib/scan-job-client";
import { Turnstile, turnstileEnabled } from "./Turnstile";

type Status = "idle" | "auto" | "scanning" | "roasting" | "error" | "timeout";
type Mode = "auto" | "manual";

/** Interaction events that mark a real visitor (crawlers render, they don't scroll or point). */
const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart", "wheel"] as const;

/** One automatic attempt per tab session and profile, even across reloads. */
export const autoRescanSessionKey = (username: string) =>
  `ghfind:auto-rescan:${username.toLowerCase()}`;

function claimAutoAttempt(username: string): boolean {
  try {
    const key = autoRescanSessionKey(username);
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * The 重新评测 action inside the 历史评分 notice.
 *
 * - Manual: the existing rescan flow (POST /api/scan?force=1 → roast refresh),
 *   then refresh the server-rendered profile so score, rank and the versioned
 *   card URLs (`?v=<scanned_at>`) swap in place.
 * - Auto (`auto`): stale-while-revalidate for a score from an older scoring
 *   release. After hydration and the visitor's first real interaction, ask the
 *   server for a background re-evaluation (score only, no LLM). The server
 *   decides — kill switch, bot filter, staleness, per-user 24h cooldown and a
 *   global hourly budget — and a deferral leaves the historical score as is.
 */
export function StaleScoreRescan({
  username,
  auto,
}: {
  username: string;
  auto: boolean;
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [token, setToken] = useState("");
  const [needVerify, setNeedVerify] = useState(false);
  const pendingRef = useRef<Mode | null>(null);
  const startedRef = useRef(false);

  const run = useCallback(
    async (mode: Mode) => {
      if (turnstileEnabled() && !token) {
        pendingRef.current = mode;
        setNeedVerify(true);
        return;
      }
      setStatus(mode === "auto" ? "auto" : "scanning");
      try {
        const scanRes = await fetch(mode === "auto" ? "/api/scan" : "/api/scan?force=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            mode === "auto"
              ? { username, turnstileToken: token, trigger: AUTO_RESCAN_TRIGGER }
              : { username, turnstileToken: token },
          ),
        });
        if (!scanRes.ok) {
          // A deferred automatic run is not an error: keep the historical score.
          setStatus(mode === "auto" ? "idle" : "error");
          return;
        }
        const scan = completedScanPayload(await readScanResponse(scanRes));
        if (!scan) {
          setStatus(mode === "auto" ? "idle" : "error");
          return;
        }
        if (mode === "manual") {
          setStatus("roasting");
          const roastRes = await fetch("/api/roast", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: roastClientSignal(),
            body: JSON.stringify({ scan, byoKey: null, lang: locale, refresh: true }),
          });
          // The new score is already published; a failed optional report must
          // not keep the page on the historical score.
          if (roastRes.ok && roastRes.body) await consumeRoastStream(roastRes, {});
        }
        if (mode === "auto") {
          // The score-only auto rescan leaves the report on the old release;
          // let the refreshed page start the re-roast without a new gesture.
          try {
            window.sessionStorage.setItem(autoReroastArmedKey(username), String(Date.now()));
          } catch {
            // storage unavailable: the re-roast still starts on interaction
          }
        }
        router.refresh();
      } catch (error) {
        if (mode === "auto") {
          setStatus("idle");
        } else {
          setStatus(isRoastClientTimeout(error) ? "timeout" : "error");
        }
      }
    },
    [token, username, locale, router],
  );

  // Resume whichever run was waiting on the Turnstile token.
  useEffect(() => {
    if (token && pendingRef.current) {
      const mode = pendingRef.current;
      pendingRef.current = null;
      void run(mode);
    }
  }, [token, run]);

  // Auto: only after hydration, in a visible tab, on a real interaction, in a
  // non-automated browser, once per session.
  useEffect(() => {
    if (!auto || startedRef.current) return;
    if (typeof window === "undefined" || navigator.webdriver) return;
    const start = () => {
      if (startedRef.current || document.visibilityState !== "visible") return;
      startedRef.current = true;
      detach();
      if (claimAutoAttempt(username)) void run("auto");
    };
    const detach = () => {
      for (const name of INTERACTION_EVENTS) window.removeEventListener(name, start);
    };
    for (const name of INTERACTION_EVENTS) {
      window.addEventListener(name, start, { passive: true });
    }
    return detach;
  }, [auto, username, run]);

  const busy = status === "auto" || status === "scanning" || status === "roasting";
  const progress =
    status === "auto" || status === "scanning"
      ? t("scoreStateRescanRunning")
      : status === "roasting"
        ? t("scoreStateRescanReport")
        : null;

  return (
    <div className="mt-1.5" data-stale-rescan={auto ? "auto" : "manual"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          shape="pill"
          className="h-6 gap-1 px-2.5 text-[11px] text-amber-200"
          disabled={busy}
          onClick={() => void run("manual")}
        >
          <RefreshCw aria-hidden className="h-3 w-3" />
          {t("scoreStateRescanAction")}
        </Button>
        {progress && (
          <span role="status" className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
            <LoaderCircle aria-hidden className="h-3 w-3 animate-spin" />
            {progress}
          </span>
        )}
        {(status === "error" || status === "timeout") && (
          <span role="alert" className="text-[11px] text-rose-300">
            {status === "timeout" ? t("scoreStateRescanTimeout") : t("scoreStateRescanError")}
          </span>
        )}
      </div>
      {needVerify && !token && <Turnstile onToken={setToken} />}
    </div>
  );
}
