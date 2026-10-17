import type { ScanResult } from "@/lib/types";

const SCAN_JOB_TIMEOUT_MS = 180_000;
const SCAN_JOB_POLL_MS = 5_000;

type ScanJobPayload = {
  error?: string;
  status?: {
    state?: string;
    error?: string;
  };
  result?: ScanResult;
  metrics?: unknown;
  scoring?: unknown;
};

function scanJobError(code: string) {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  return error;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response, fallback: number): number {
  const raw = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 30) * 1000;
  return fallback;
}

export function completedScanPayload(payload: unknown): ScanResult | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as ScanJobPayload;
  if (row.result && typeof row.result === "object" && row.result.metrics && row.result.scoring) {
    return row.result;
  }
  if (row.metrics && row.scoring) return payload as ScanResult;
  return null;
}

export async function readScanResponse(response: Response): Promise<unknown> {
  const initial = await response.json().catch(() => null);
  if (response.status !== 202) {
    return initial;
  }
  const location = response.headers.get("Location");
  if (!location) {
    throw scanJobError("scan_status_missing");
  }
  const deadline = Date.now() + SCAN_JOB_TIMEOUT_MS;
  let last: ScanJobPayload | null =
    initial && typeof initial === "object" ? (initial as ScanJobPayload) : null;
  let interval = retryAfterMs(response, SCAN_JOB_POLL_MS);
  while (Date.now() < deadline) {
    const poll = await fetch(location, { cache: "no-store" });
    const payload = (await poll.json().catch(() => null)) as ScanJobPayload | null;
    last = payload;
    const done = completedScanPayload(payload);
    if (poll.status === 200 && done) return done;
    if (payload?.result && poll.ok) return payload.result;
    if (poll.status === 202) {
      interval = retryAfterMs(poll, SCAN_JOB_POLL_MS);
      await delay(interval);
      continue;
    }
    if (!poll.ok) {
      throw scanJobError(
        (payload && typeof payload.error === "string" && payload.error) ||
          payload?.status?.error ||
          "scan_status_unavailable",
      );
    }
    if (payload?.status?.state === "failed") {
      throw scanJobError(payload.status.error || "scan_failed");
    }
    await delay(interval);
  }
  throw scanJobError(last?.status?.error || last?.error || "scan_timeout");
}
