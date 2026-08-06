"use client";

/** Start the Go-owned GitHub OAuth redirect without depending on NextAuth. */
export function signInWithGitHub(callbackUrl?: string): void {
  if (typeof window === "undefined") return;
  const target = callbackUrl ?? window.location.href;
  window.location.assign(`/api/auth/github?callbackUrl=${encodeURIComponent(target)}`);
}

/** End the Go-owned signed session and return to the public home page. */
export async function signOutOfGitHub(): Promise<void> {
  try {
    await fetch("/api/auth/signout", { method: "POST", credentials: "same-origin" });
  } finally {
    if (typeof window !== "undefined") window.location.assign("/");
  }
}
