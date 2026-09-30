import type { ScanResult } from "@/lib/types";

/**
 * devscore collection runs as a background job that can take minutes for large
 * accounts. Each status poll also advances the job one step server-side, so an
 * open page drives its own computation.
 */
export const SCAN_JOB_TIMEOUT_MS = 15 * 60_000;
export const SCAN_JOB_POLL_MS = 2_000;

export type ScanJobState = "queued" | "running" | "done" | "failed";

/** Pending body of `202` responses and `GET /api/scan/status/<login>`. */
export interface ScanJobStatus {
  state: ScanJobState;
  /** Collector phase ("queued", "user", "contribs", …, "publish"). */
  phase?: string;
  /** 0..1 */
  progress?: number;
  error?: string;
}

type ScanJobPayload = {
  status?: Partial<ScanJobStatus>;
  result?: ScanResult;
};

export interface ReadScanOptions {
  /** Called with every pending status (the initial 202 body and each poll). */
  onStatus?: (status: ScanJobStatus) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
}

function scanJobError(code: string) {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  return error;
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(scanJobError("scan_aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(scanJobError("scan_aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function pendingStatus(payload: ScanJobPayload | null): ScanJobStatus | null {
  const s = payload?.status;
  if (!s || typeof s.state !== "string") return null;
  return {
    state: s.state as ScanJobState,
    ...(typeof s.phase === "string" ? { phase: s.phase } : {}),
    ...(typeof s.progress === "number" && Number.isFinite(s.progress)
      ? { progress: Math.min(1, Math.max(0, s.progress)) }
      : {}),
    ...(typeof s.error === "string" ? { error: s.error } : {}),
  };
}

/**
 * Resolve a scan/score response: non-202 bodies are returned as-is; a 202 is
 * followed through its `Location` until the job publishes a result, fails, or
 * the long wait expires.
 */
export async function readScanResponse(
  response: Response,
  options: ReadScanOptions = {},
): Promise<unknown> {
  const initial = await response.json().catch(() => null);
  if (response.status !== 202) {
    return initial;
  }
  const location = response.headers.get("Location");
  if (!location) {
    throw scanJobError("scan_status_missing");
  }
  const pollMs = options.pollMs ?? SCAN_JOB_POLL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? SCAN_JOB_TIMEOUT_MS);
  let last = pendingStatus(initial as ScanJobPayload | null);
  if (last) options.onStatus?.(last);
  while (Date.now() < deadline) {
    const poll = await fetch(location, { cache: "no-store", signal: options.signal });
    const payload = (await poll.json().catch(() => null)) as ScanJobPayload | null;
    if (!poll.ok) {
      throw scanJobError(payload?.status?.error || "scan_status_unavailable");
    }
    if (payload?.result) {
      return payload.result;
    }
    const status = pendingStatus(payload);
    if (status?.state === "failed") {
      throw scanJobError(status.error || "scan_failed");
    }
    if (status) {
      last = status;
      options.onStatus?.(status);
    }
    await delay(pollMs, options.signal);
  }
  throw scanJobError(last?.error || "scan_timeout");
}

/** Status URL of one account's background scoring job. */
export function scanStatusUrl(username: string): string {
  return `/api/scan/status/${encodeURIComponent(username)}`;
}

/**
 * Wait for an account's already-enqueued job (e.g. a profile page opened while
 * the score is still computing). Each poll advances the job server-side.
 */
export async function waitForScanJob(
  username: string,
  options: ReadScanOptions = {},
): Promise<ScanResult> {
  const pending = new Response(JSON.stringify({ status: { state: "queued" } }), {
    status: 202,
    headers: { Location: scanStatusUrl(username) },
  });
  return (await readScanResponse(pending, options)) as ScanResult;
}
