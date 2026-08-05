import type { ScanResult } from "@/lib/types";

const SCAN_JOB_TIMEOUT_MS = 75_000;
const SCAN_JOB_POLL_MS = 1_000;

type ScanJobPayload = {
  status?: {
    state?: string;
    error?: string;
  };
  result?: ScanResult;
};

function scanJobError(code: string) {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  return error;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  while (Date.now() < deadline) {
    const poll = await fetch(location, { cache: "no-store" });
    const payload = (await poll.json().catch(() => null)) as ScanJobPayload | null;
    if (!poll.ok) {
      throw scanJobError(payload?.status?.error || "scan_status_unavailable");
    }
    last = payload;
    if (payload?.result) {
      return payload.result;
    }
    if (payload?.status?.state === "failed") {
      throw scanJobError(payload.status.error || "scan_failed");
    }
    await delay(SCAN_JOB_POLL_MS);
  }
  throw scanJobError(last?.status?.error || "scan_timeout");
}
