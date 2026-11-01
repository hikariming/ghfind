"use client";

import type { LoginProvider } from "@/lib/me-client";

/** Start the server-owned provider flow; tokens stay outside the browser. */
export function signInWithProvider(provider: LoginProvider, callbackUrl?: string): void {
  if (typeof window === "undefined") return;
  const target = new URL(callbackUrl ?? window.location.href, window.location.origin);
  target.searchParams.delete("auth_error");
  window.location.assign(`/api/auth/${provider}?callbackUrl=${encodeURIComponent(target.href)}`);
}

/** GitHub-specific features intentionally retain this explicit entry point. */
export function signInWithGitHub(callbackUrl?: string): void {
  signInWithProvider("github", callbackUrl);
}

/** End every provider session and return to the public home page. */
export async function signOut(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/signout", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    if (typeof window !== "undefined") window.location.assign("/");
    return true;
  } catch {
    return false;
  }
}

/** Compatibility alias for existing GitHub feature surfaces. */
export const signOutOfGitHub = signOut;
