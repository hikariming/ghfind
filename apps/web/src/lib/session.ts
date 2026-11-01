import { env } from "cloudflare:workers";

interface Service {
  fetch(request: Request): Promise<Response>;
}

/**
 * Session-dependent reads go to ghfind-api over the API service binding, with
 * the visitor's cookie — the auth secrets stay on the API Worker only. The
 * answers match the Next app's `auth()`/`oauthConfigured()` (same handlers).
 */
async function apiJson<T>(request: Request, path: string): Promise<T | null> {
  const api = env.API as Service | undefined;
  if (!api) return null;
  try {
    const headers: Record<string, string> = {};
    const cookie = request.headers.get("cookie");
    if (cookie) headers.cookie = cookie;
    const res = await api.fetch(new Request(new URL(path, request.url), { headers }));
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export interface Viewer {
  /** Signed-in GitHub login, or null. */
  login: string | null;
  /** Whether this deployment offers GitHub sign-in at all. */
  oauth: boolean;
}

/** Whether the request may carry a session; without one the visitor is anonymous. */
export function hasSessionCookie(request: Request): boolean {
  return request.headers.get("cookie")?.includes("ghfind_session=") ?? false;
}

// `oauth` only changes with the API Worker's deployed secrets, so anonymous
// visitors (nearly all crawler traffic) reuse the first successful answer
// instead of costing an API Worker invocation per render. Failures aren't
// memoized, so a transient error can't hide the login UI for the isolate.
let anonymousOauth: boolean | null = null;

export async function getViewer(request: Request): Promise<Viewer> {
  const anonymous = !hasSessionCookie(request);
  if (anonymous && anonymousOauth !== null) return { login: null, oauth: anonymousOauth };
  const me = await apiJson<{ user: { login: string } | null; oauth: boolean }>(request, "/api/me");
  if (anonymous && me) anonymousOauth = Boolean(me.oauth);
  return { login: me?.user?.login ?? null, oauth: Boolean(me?.oauth) };
}

export async function isSignedIn(request: Request): Promise<boolean> {
  if (!hasSessionCookie(request)) return false;
  return (await getViewer(request)).login !== null;
}

/** GET an API route as the visitor (their cookie), e.g. reaction state. */
export function getAsViewer<T>(request: Request, path: string): Promise<T | null> {
  return apiJson<T>(request, path);
}
