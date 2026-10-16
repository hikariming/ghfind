"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { readScanResponse, type ScanJobStatus } from "@/lib/scan-job-client";
import { consumeRoastStream } from "@/lib/roast-stream";
import type { ScanResult } from "@/lib/types";
import { Turnstile, turnstileEnabled } from "./Turnstile";
import { ScoreJobProgress } from "./ScoreJobProgress";

type Status = "idle" | "scanning" | "roasting" | "error";

/**
 * Summon an unscored opponent into a PK: runs scan → roast for `username` (which
 * persists the score), then refreshes the server-rendered /vs page so the newly
 * scored side fills in. User-initiated (no automatic scan on visit), so a cold
 * /vs link carries no passive cost. Mirrors {@link RescanButton}'s pipeline.
 */
export function VsSummonButton({ username }: { username: string }) {
  const t = useTranslations("vs");
  const tScan = useTranslations("scanErrors");
  const tJob = useTranslations("scoreJob");
  const locale = useLocale();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [jobStatus, setJobStatus] = useState<ScanJobStatus | null>(null);
  const [errorText, setErrorText] = useState("");
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
    setJobStatus(null);
    setErrorText("");
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
      const scan = (await readScanResponse(scanRes, { onStatus: setJobStatus })) as ScanResult;
      setJobStatus(null);
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
      // Decode the stream so in-band failures are not mistaken for a completed roast.
      const { errored } = await consumeRoastStream(roastRes, {
        onError: () => setStatus("error"),
      });
      if (errored) return;
      router.refresh();
      setStatus("idle");
    } catch (e) {
      const code = (e as { code?: string })?.code;
      setErrorText(
        code === "scan_timeout"
          ? tJob("timeout")
          : typeof code === "string" && code !== "scan_aborted"
            ? tScan.has(code)
              ? tScan(code)
              : tJob("failed")
            : t("summonError"),
      );
      setJobStatus(null);
      setStatus("error");
    }
  }, [token, username, locale, router, t, tJob, tScan]);

  // Resume a click that was waiting on the Turnstile token.
  useEffect(() => {
    if (token && pendingRef.current) {
      pendingRef.current = false;
      void run();
    }
  }, [token, run]);

  const label =
    status === "scanning"
      ? jobStatus
        ? tJob("computing") +
          (typeof jobStatus.progress === "number"
            ? ` ${Math.round(Math.min(1, Math.max(0, jobStatus.progress)) * 100)}%`
            : "…")
        : t("summonScanning")
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
      {status === "scanning" && jobStatus && (
        <div className="text-xs text-zinc-400">
          <ScoreJobProgress compact status={jobStatus} />
        </div>
      )}
      {status === "error" && (
        <div className="text-xs text-rose-300">{errorText || t("summonError")}</div>
      )}
    </div>
  );
}
