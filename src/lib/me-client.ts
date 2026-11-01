/**
 * Shared, deduplicated `/api/me` probe for client islands.
 *
 * The navbar (NavAuth), the login nudge, and the mobile menu each probe the
 * session on mount — before this module that was 2-3 identical serverless
 * invocations per pageview, bots included. The session cannot change under a
 * page (sign-in/out always navigates), so one promise per page load serves
 * every caller.
 */

export type LoginProvider = "github" | "google" | "apple";
export type LoginProviders = Record<LoginProvider, boolean>;
export type SiteAccount = {
  provider: LoginProvider;
  subject: string;
  name: string;
  image: string | null;
};

export type Me = {
  /** GitHub identity only: other providers do not grant GitHub capabilities. */
  user: { login: string; image: string | null } | null;
  account?: SiteAccount | null;
  providers?: LoginProviders;
  scored: boolean;
  /**
   * Runtime answer to "can this deployment offer GitHub login?", decided by the
   * Worker that actually holds the OAuth secrets. Optional because prerendered
   * pages must not bake a build-time answer: absent means "unknown", and callers
   * treat unknown as configured (the pre-flag behavior).
   */
  oauth?: boolean;
  /** A failed probe is distinct from a deployment with no login providers. */
  loadFailed?: boolean;
};

const UNAVAILABLE: Me = { user: null, scored: false, oauth: false, loadFailed: true };

export function loginProviders(me: Me): LoginProviders {
  if (me.loadFailed) return { github: false, google: false, apple: false };
  return me.providers
    ? { github: me.providers.github === true, google: me.providers.google === true, apple: me.providers.apple === true }
    : { github: me.oauth !== false, google: false, apple: false };
}

let inflight: Promise<Me> | null = null;

export function fetchMe({ refresh = false }: { refresh?: boolean } = {}): Promise<Me> {
  if (refresh) inflight = null;
  if (!inflight) {
    inflight = fetch("/api/me", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000) })
      .then(async (r) => {
        if (!r.ok) throw new Error("account_probe_failed");
        const value = await r.json() as Me;
        if (!value || typeof value !== "object" || !("user" in value) || typeof value.scored !== "boolean") {
          throw new Error("account_probe_invalid");
        }
        return value;
      })
      .catch(() => {
        // Serve this caller the signed-out fallback but allow a later caller
        // (e.g. the menu opening after a transient network blip) to retry.
        inflight = null;
        return UNAVAILABLE;
      });
  }
  return inflight;
}
