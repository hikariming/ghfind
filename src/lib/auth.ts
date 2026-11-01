import { cookies } from "next/headers";
import {
  OAUTH_SESSION_COOKIE,
  readGitHubSession,
  oauthConfigured,
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
  const session = readGitHubSession(raw);
  if (!session) return null;
  return {
    user: { githubId: session.github_id, login: session.login, image: session.avatar_url ?? null },
  };
}
