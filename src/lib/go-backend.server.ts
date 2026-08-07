import "server-only";

import { headers } from "next/headers";

export function goBackendOrigin(): string | null {
  const raw = process.env.GHFIND_BACKEND_ORIGIN?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Reads a public presentation model from Go for a Next-owned renderer. No
 * secret is sent: these are the same public score fields the embed exposes.
 *
 * Default `no-store` only works on dynamically rendered routes: inside a
 * `force-static`/ISR page (the homepage) a no-store fetch never runs during
 * prerender, so sections built on it silently render empty. Pass
 * `opts.revalidate` from static pages to get an ISR-compatible cached fetch.
 */
export async function getGoPublicData<T>(
  path: string,
  opts?: { revalidate?: number },
): Promise<T | null> {
  const origin = goBackendOrigin();
  if (!origin || !path.startsWith("/")) return null;
  try {
    const response = await fetch(new URL(path, origin), {
      ...(opts?.revalidate
        ? { next: { revalidate: opts.revalidate } }
        : { cache: "no-store" }),
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Read a session-scoped Go response while forwarding only the caller's cookies. */
export async function getGoPrivateData<T>(path: string): Promise<T | null> {
  const origin = goBackendOrigin();
  if (!origin || !path.startsWith("/")) return null;
  try {
    const requestHeaders = await headers();
    const cookie = requestHeaders.get("cookie");
    const response = await fetch(new URL(path, origin), {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
