/**
 * Shared, deduplicated `/api/me` probe for client islands.
 *
 * The navbar (NavAuth), the login nudge, and the mobile menu each probe the
 * session on mount — before this module that was 2-3 identical serverless
 * invocations per pageview, bots included. The session cannot change under a
 * page (sign-in/out always navigates), so one promise per page load serves
 * every caller.
 */

export type Me = {
  user: { login: string; image: string | null } | null;
  scored: boolean;
};

const SIGNED_OUT: Me = { user: null, scored: false };

let inflight: Promise<Me> | null = null;

export function fetchMe(): Promise<Me> {
  if (!inflight) {
    inflight = fetch("/api/me")
      .then((r) => r.json() as Promise<Me>)
      .catch(() => {
        // Serve this caller the signed-out fallback but allow a later caller
        // (e.g. the menu opening after a transient network blip) to retry.
        inflight = null;
        return SIGNED_OUT;
      });
  }
  return inflight;
}
