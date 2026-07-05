"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ROAST_FRESH_MS } from "@/lib/freshness";
import type { ScanResult } from "@/lib/types";
import { Turnstile, turnstileEnabled } from "./Turnstile";

type Status = "idle" | "scanning" | "roasting" | "error";

const COOLDOWN_MS = ROAST_FRESH_MS;

/**
 * Inline re-detect on a profile page: re-runs scan → roast for `username`, then
 * refreshes the server-rendered page so the new score and rank show up.
 *
 * Honors the same 24h cache as the detection pipeline — within `COOLDOWN_MS` of
 * the last scan the button is disabled (a fresh run would just replay the cache),
 * with a hint about when it can be refreshed.
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
  const cooldownLeft = now == null ? 0 : Math.max(0, scannedAt + COOLDOWN_MS - now);
  const onCooldown = cooldownLeft > 0;

  const run = useCallback(async () => {
    if (turnstileEnabled() && !token) {
      pendingRef.current = true;
      setNeedVerify(true);
      return;
    }
    setStatus("scanning");
    try {
      const scanRes = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, turnstileToken: token }),
      });
      if (!scanRes.ok) {
        setStatus("error");
        return;
      }
      const scan = (await scanRes.json()) as ScanResult;
      setStatus("roasting");
      const roastRes = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `refresh` skips the roast replay paths (Redis + DB archive) so this
        // actually regenerates; without it the archive replays the old report.
        // The server re-validates staleness, matching the cooldown gate above.
        body: JSON.stringify({ scan, byoKey: null, lang: locale, refresh: true }),
      });
      if (!roastRes.ok || !roastRes.body) {
        setStatus("error");
        return;
      }
      // Drain the stream so the roast fully completes and the score is persisted.
      const reader = roastRes.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      router.refresh();
      setStatus("idle");
    } catch {
      setStatus("error");
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

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy || onCooldown}
        className="w-full rounded-full bg-orange-600/90 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
      {needVerify && !token && <Turnstile onToken={setToken} />}
      {status === "error" && (
        <div className="mt-1.5 text-xs text-rose-300">{t("error")}</div>
      )}
      {now != null && onCooldown && status === "idle" && (
        <div className="mt-1.5 text-[11px] text-zinc-500">
          {t("cooldown", { hours: Math.ceil(cooldownLeft / (60 * 60 * 1000)) })}
        </div>
      )}
    </div>
  );
}
