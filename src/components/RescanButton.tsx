"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RESCAN_COOLDOWN_MS } from "@/lib/freshness";
import { readScanResponse } from "@/lib/scan-job-client";
import { consumeRoastStream } from "@/lib/roast-stream";
import { isRoastClientTimeout, roastClientSignal } from "@/lib/roast-client-timeout";
import type { ScanResult } from "@/lib/types";
import { Turnstile, turnstileEnabled } from "./Turnstile";

type Status = "idle" | "scanning" | "roasting" | "error" | "timeout";

/**
 * Inline re-detect on a profile page: re-runs scan → roast for `username`, then
 * refreshes the server-rendered page so the new score and rank show up.
 *
 * Honors {@link RESCAN_COOLDOWN_MS} (24h) — within that window of the last scan
 * the button is disabled (a fresh run would just replay the cache), with a hint
 * about when it can be refreshed. Server-side `/api/roast` `refresh` uses the
 * same window (aligned with Go `roastFreshness`).
 */
export function RescanButton({
  username,
  scannedAt,
  className = "",
}: {
  username: string;
  scannedAt: number;
  className?: string;
}) {
  const t = useTranslations("rescan");
  const locale = useLocale();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [token, setToken] = useState("");
  const [needVerify, setNeedVerify] = useState(false);
  // Cooldown depends on the current time, so resolve it after mount to avoid a
  // hydration mismatch between the server and client clocks.
  const [now, setNow] = useState<number | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    // Deferred (not synchronous) so the cooldown resolves after hydration.
    const id = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(id);
  }, []);

  const busy = status === "scanning" || status === "roasting";
  const cooldownLeft = now == null ? 0 : Math.max(0, scannedAt + RESCAN_COOLDOWN_MS - now);
  const onCooldown = cooldownLeft > 0;

  const run = useCallback(async () => {
    if (turnstileEnabled() && !token) {
      pendingRef.current = true;
      setNeedVerify(true);
      return;
    }
    setStatus("scanning");
    try {
      const scanRes = await fetch("/api/scan?force=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, turnstileToken: token }),
      });
      if (!scanRes.ok) {
        setStatus("error");
        return;
      }
      const scan = (await readScanResponse(scanRes)) as ScanResult;
      setStatus("roasting");
      const roastRes = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: roastClientSignal(),
        // `refresh` asks the server to regenerate when past RESCAN_COOLDOWN_MS;
        // a compatible roast may still replay when the score did not change.
        // The server re-validates staleness, matching the cooldown gate above.
        body: JSON.stringify({ scan, byoKey: null, lang: locale, refresh: true }),
      });
      if (!roastRes.ok || !roastRes.body) {
        setStatus("error");
        return;
      }
      // Decode the stream so in-band failures are not mistaken for a completed roast.
      const { errored } = await consumeRoastStream(roastRes, {
        onError: () => setStatus("error"),
      });
      if (errored) return;
      router.refresh();
      setStatus("idle");
    } catch (error) {
      setStatus(isRoastClientTimeout(error) ? "timeout" : "error");
    }
  }, [token, username, locale, router]);

  // Once the Turnstile token arrives, resume a click that was waiting on it.
  useEffect(() => {
    if (token && pendingRef.current) {
      pendingRef.current = false;
      void run();
    }
  }, [token, run]);

  const label =
    status === "scanning"
      ? t("scanning")
      : status === "roasting"
        ? t("roasting")
        : t("button");

  const Icon =
    status === "scanning" || status === "roasting" ? LoaderCircle : RefreshCw;

  return (
    <div className={className}>
      <Button
        type="button"
        variant="default"
        size="default"
        shape="pill"
        onClick={() => void run()}
        disabled={busy || onCooldown}
        aria-busy={busy}
        className="w-full gap-2 bg-orange-600 text-white shadow-md shadow-orange-600/25 hover:bg-orange-500 disabled:bg-orange-600/40 disabled:text-white/70 disabled:opacity-100"
      >
        <Icon
          className={`size-4 shrink-0 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`}
          aria-hidden
        />
        <span>{label}</span>
      </Button>
      {needVerify && !token && <Turnstile onToken={setToken} />}
      {(status === "error" || status === "timeout") && (
        <div className="mt-1.5 text-xs text-rose-300" role="alert">
          {status === "timeout" ? t("timeout") : t("error")}
        </div>
      )}
      {now != null && onCooldown && status === "idle" && (
        <div className="mt-1.5 text-center text-[11px] text-zinc-400">
          {t("cooldown", { hours: Math.ceil(cooldownLeft / (60 * 60 * 1000)) })}
        </div>
      )}
    </div>
  );
}
