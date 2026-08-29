import { cookies } from "next/headers";
import { normalizeGitHubUsername } from "@/lib/comments";
import {
  OAUTH_SESSION_COOKIE,
  decodeSignedPayload,
  oauthConfigured,
  type OAuthSession,
} from "@/lib/oauth-session";

/**
 * Session accessor with the shape the social route handlers were written
 * against (the old next-auth `auth()` contract), now backed by the repatriated
 * HMAC session cookie (`@/lib/oauth-session`, Go wire-format compatible).
 */

export type AppSession = {
  user: { githubId: number; login: string; image: string | null };
};

export function authConfigured(): boolean {
  return oauthConfigured();
}

export async function auth(): Promise<AppSession | null> {
  const jar = await cookies();
  const raw = jar.get(OAUTH_SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = decodeSignedPayload<OAuthSession>("session", raw);
  if (!session || session.github_id <= 0) return null;
  const login = normalizeGitHubUsername(session.login ?? "");
  if (!login) return null;
  if (session.expires_at <= Date.now()) return null;
  return {
    user: { githubId: session.github_id, login, image: session.avatar_url ?? null },
  };
}
