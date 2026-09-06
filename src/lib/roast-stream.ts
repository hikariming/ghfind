/**
 * Client-side decoder for the /api/roast streamed response.
 *
 * The body is plain report markdown EXCEPT for leading control frames: lines
 * prefixed with the frame separator (\x1f) carry progress (T), the AI-adjusted
 * meta (M, which ends the control phase), or an error (E). Cached/replayed
 * roasts send pure markdown with no frames at all. This module owns that parsing
 * so the homepage `Roaster` and the profile-page `LiveRoast` decode it
 * identically. Framework-free (no React) — callers wire the callbacks to state.
 */
import type { RoastMeta } from "./types";

const FRAME = "\x1f";

/**
 * sessionStorage key under which the homepage stashes a fresh scan before
 * navigating to /u/{username}, so the profile page can render + roast it without
 * depending on a server-side cache. Lowercased since GitHub handles are
 * case-insensitive and the URL slug may differ in casing.
 */
export function pendingScanKey(username: string): string {
  return `pendingScan:${username.toLowerCase()}`;
}

/** Decode a base64 RoastMeta (header fast path or in-band M-frame). */
export function decodeRoastMeta(b64: string): RoastMeta | null {
  try {
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    return JSON.parse(json) as RoastMeta;
  } catch {
    return null;
  }
}

export interface RoastStreamCallbacks {
  /** Live progress label (T-frame) during the judge → writer wait. */
  onThinking?(label: string): void;
  /** AI-adjusted meta, from the X-Roast-Meta header or the M-frame. */
  onMeta?(meta: RoastMeta): void;
  /** The report markdown accumulated so far (called on each new chunk). */
  onReport?(accumulated: string): void;
  /** Server error (preflight JSON already handled by caller, or an E-frame). */
  onError?(data: {
    error?: string;
    useByoKey?: boolean;
    fallback?: { report?: string; meta?: RoastMeta };
  }): void;
}

/**
 * Read a successful /api/roast Response body to completion, invoking callbacks
 * as frames/markdown arrive. Reads the X-Roast-Meta header first (a deterministic
 * meta fallback sent before the body can know the AI-adjusted values). Returns
 * the full report text, whether an E-frame aborted it, and `fresh` — true when
 * the stream carried any T/M control frame, i.e. this was a real (uncached) LLM
 * generation. Cached/archived/replayed roasts send pure markdown with no frames,
 * so `fresh` stays false; callers use this to only surface the result popup when
 * the model actually ran.
 */
export async function consumeRoastStream(
  res: Response,
  cb: RoastStreamCallbacks,
): Promise<{ report: string; errored: boolean; fresh: boolean }> {
  const metaHeader = res.headers.get("X-Roast-Meta");
  if (metaHeader) {
    const meta = decodeRoastMeta(metaHeader);
    if (meta) cb.onMeta?.(meta);
  }

  if (!res.body) return { report: "", errored: false, fresh: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let inReport = false;
  let acc = "";
  let aborted = false;
  // Any T/M control frame means the leader ran the two-pass LLM live; replays
  // (cache/archive/single-flight follower) are pure markdown with no frames.
  let fresh = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    while (!inReport && buf.length > 0) {
      // Anything not starting with the frame separator is report content.
      if (buf[0] !== FRAME) {
        inReport = true;
        break;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) break; // partial control line — wait for more bytes
      const type = buf[1];
      const payload = buf.slice(2, nl);
      buf = buf.slice(nl + 1);
      if (type === "T") {
        fresh = true;
        cb.onThinking?.(payload);
      } else if (type === "M") {
        fresh = true;
        const meta = decodeRoastMeta(payload);
        if (meta) cb.onMeta?.(meta);
        inReport = true;
      } else if (type === "E") {
        try {
          cb.onError?.(JSON.parse(payload));
        } catch {
          cb.onError?.({});
        }
        aborted = true;
        break;
      }
    }
    if (aborted) break;
    if (inReport && buf) {
      acc += buf;
      buf = "";
      cb.onReport?.(acc);
    }
  }

  return { report: acc, errored: aborted, fresh };
}
