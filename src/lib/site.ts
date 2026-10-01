export { bcp47, localeAlternates, localePath } from "@ghfind/i18n";

const DEFAULT_SITE_URL = "https://ghfind.com";

export interface SiteUrlEnvironment {
  [name: string]: string | undefined;
  NEXT_PUBLIC_SITE_URL?: string;
  PUBLIC_SITE_URL?: string;
  /** Platform-neutral deployment env (Cloudflare, set via wrangler vars). */
  GHFIND_DEPLOY_ENV?: string;
}

function configuredValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseSiteOrigin(value: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid absolute origin`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${variable} must use http or https`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${variable} must contain only an origin`);
  }
  return url.origin;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/**
 * Resolve the one public origin used by metadata, machine documents, API
 * profile links, share surfaces, and provider attribution. Production requires
 * both public settings so a stale higher-priority value cannot shadow the
 * operator's intended origin.
 */
export function resolveSiteUrl(environment: SiteUrlEnvironment): string {
  const nextPublicRaw = configuredValue(environment.NEXT_PUBLIC_SITE_URL);
  const publicRaw = configuredValue(environment.PUBLIC_SITE_URL);
  const production = environment.GHFIND_DEPLOY_ENV === "production";

  if (production && (!nextPublicRaw || !publicRaw)) {
    throw new Error("Production requires NEXT_PUBLIC_SITE_URL and PUBLIC_SITE_URL");
  }

  const nextPublic = nextPublicRaw
    ? parseSiteOrigin(nextPublicRaw, "NEXT_PUBLIC_SITE_URL")
    : null;
  const publicUrl = publicRaw ? parseSiteOrigin(publicRaw, "PUBLIC_SITE_URL") : null;

  if (production) {
    if (nextPublic !== publicUrl) {
      throw new Error("Production site URL settings must match");
    }
    const url = new URL(nextPublic!);
    if (url.protocol !== "https:" || isLocalHostname(url.hostname)) {
      throw new Error("Production site URL must be a non-local HTTPS origin");
    }
  }

  return nextPublic ?? publicUrl ?? DEFAULT_SITE_URL;
}

/**
 * Single source of truth for the public site origin.
 *
 * Previously `layout.tsx` hardcoded the domain while `u/[username]/page.tsx`,
 * `llm.ts`, etc. read `PUBLIC_SITE_URL` — so the canonical/OG host could drift
 * from the actual deployment. Everything that needs an absolute URL (metadata,
 * sitemap, robots, JSON-LD) now imports `SITE_URL` from here.
 */
export const SITE_URL = resolveSiteUrl(process.env);

/**
 * Minimum public score for a profile to be submitted to search engines.
 *
 * Profiles below this are still reachable and shareable, but are kept out of the
 * sitemap AND marked `noindex` — we publish scores/roasts about real, named
 * people, so we don't want low-score ("NPC"/"拉完了") pages ranking on someone's
 * name. Matches the leaderboard's public floor.
 */
export const PUBLIC_INDEX_MIN_SCORE = 60;

/**
 * Minimum score BOTH sides of a PK must clear for the /vs page to (a) spend an
 * LLM call on a savage verdict and (b) be indexed / added to the sitemap. Lower
 * than the profile floor: a duel is interesting even at "solid" tier, but we
 * still don't burn the model or index pages on low-value matchups.
 */
export const VS_MIN_SCORE = 55;
