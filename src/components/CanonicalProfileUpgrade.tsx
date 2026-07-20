"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  canonicalProfileUpgradePollMs,
  isCanonicalProfileUpgradeComplete,
} from "@/lib/canonical-profile-upgrade";

// Large public histories can take tens of minutes. The legacy profile is
// already visible, so continue observing its single explicit refresh long
// enough to switch to canonical data without starting another job.
const MAX_WAIT_MS = 45 * 60 * 1_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(done, ms);
    function done() {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function removeRefreshRunId(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("refresh_run_id")) return;
  url.searchParams.delete("refresh_run_id");
  window.history.replaceState(window.history.state, "", url);
}

/**
 * Continues one explicit home-page scan after its v5/v5/v3 handoff. It never
 * creates a job: the opaque run id is issued by POST /api/scan and verified by
 * the status endpoint. Once v4 is complete, this single user-initiated flow
 * asks for its v9 report and refreshes the server-rendered profile.
 */
export function CanonicalProfileUpgrade({
  username,
  runId,
  locale,
}: {
  username: string;
  runId: string;
  locale: string;
}) {
  const router = useRouter();

  useEffect(() => {
    const controller = new AbortController();
    const deadline = Date.now() + MAX_WAIT_MS;

    const upgrade = async () => {
      let delayMs = 5_000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        await sleep(delayMs, controller.signal);
        if (controller.signal.aborted) return;
        try {
          const response = await fetch(
            `/api/scan-status/${encodeURIComponent(username)}?run_id=${encodeURIComponent(runId)}`,
            { signal: controller.signal, cache: "no-store" },
          );
          const status = await response.json().catch(() => null);
          if (isCanonicalProfileUpgradeComplete(status)) {
            // This is the same explicit scan that initiated the fallback. It is
            // allowed one v9 report attempt; Cron never invokes this endpoint.
            const roast = await fetch("/api/roast", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username, lang: locale }),
              signal: controller.signal,
            });
            if (roast.body) {
              const reader = roast.body.getReader();
              while (!controller.signal.aborted) {
                const { done } = await reader.read();
                if (done) break;
              }
            }
            if (!controller.signal.aborted) {
              removeRefreshRunId();
              router.refresh();
            }
            return;
          }
          if (response.status === 404) return;
          delayMs = canonicalProfileUpgradePollMs(status?.retry_after);
        } catch {
          if (controller.signal.aborted) return;
          delayMs = 10_000;
        }
      }
    };

    void upgrade();
    return () => controller.abort();
  }, [locale, router, runId, username]);

  return null;
}
