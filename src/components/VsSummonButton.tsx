"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { readScanResponse } from "@/lib/scan-job-client";
import type { ScanResult } from "@/lib/types";
import { Turnstile, turnstileEnabled } from "./Turnstile";

type Status = "idle" | "scanning" | "roasting" | "error";

/**
 * Summon an unscored opponent into a PK: runs scan → roast for `username` (which
 * persists the score), then refreshes the server-rendered /vs page so the newly
 * scored side fills in. User-initiated (no automatic scan on visit), so a cold
 * /vs link carries no passive cost. Mirrors {@link RescanButton}'s pipeline.
 */
export function VsSummonButton({ username }: { username: string }) {
  const t = useTranslations("vs");
  const locale = useLocale();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [token, setToken] = useState("");
  const [needVerify, setNeedVerify] = useState(false);
  const pendingRef = useRef(false);

  const busy = status === "scanning" || status === "roasting";

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
      const scan = (await readScanResponse(scanRes)) as ScanResult;
      setStatus("roasting");
      const roastRes = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scan, byoKey: null, lang: locale }),
      });
      if (!roastRes.ok || !roastRes.body) {
        setStatus("error");
        return;
      }
      // Drain the stream so the roast completes and the score is persisted.
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

  // Resume a click that was waiting on the Turnstile token.
  useEffect(() => {
    if (token && pendingRef.current) {
      pendingRef.current = false;
      void run();
    }
  }, [token, run]);

  const label =
    status === "scanning"
      ? t("summonScanning")
      : status === "roasting"
        ? t("summonRoasting")
        : t("summon");

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded-full bg-orange-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
      {needVerify && !token && <Turnstile onToken={setToken} />}
      {status === "error" && (
        <div className="text-xs text-rose-300">{t("summonError")}</div>
      )}
    </div>
  );
}
