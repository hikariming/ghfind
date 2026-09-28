import { NextResponse } from "next/server";
import { auth } from "./auth";
import { normalizeGitHubRepository } from "./project-analysis-contract";

export function isFeedStaging(): boolean {
  return process.env.GHFIND_DEPLOY_ENV === "feed-staging" ||
    (process.env.PUBLIC_SITE_URL ?? "").startsWith("https://ghfind-feed-web-staging.");
}

function rejected(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

// Public production assessment behavior is unchanged. The separately deployed
// staging application admits only its two test identities and approved repos.
export async function authorizeStagingAssessment(repositoryUrl?: string, requestedRef?: unknown): Promise<NextResponse | null> {
  if (!isFeedStaging()) return null;
  const ids = (process.env.FEED_STAGING_ALLOWED_GITHUB_IDS ?? "").split(",");
  const repos = (process.env.FEED_STAGING_ALLOWED_REPOSITORIES ?? "").split(",");
  if (process.env.GHFIND_DEPLOY_ENV !== "feed-staging" || ids.length !== 2 || new Set(ids).size !== 2 ||
    ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) ||
    repos.length < 1 || repos.length > 4 || new Set(repos).size !== repos.length ||
    repos.some(repo => {
      try { return normalizeGitHubRepository(repo).repoKey !== repo; } catch { return true; }
    })) {
    return rejected("staging_configuration_unavailable", 503);
  }
  const session = await auth();
  if (!session) return rejected("authentication_required", 401);
  if (!ids.includes(String(session.user.githubId))) return rejected("forbidden", 403);
  if (requestedRef !== undefined && requestedRef !== null) return rejected("staging_ref_not_allowed", 403);
  if (repositoryUrl !== undefined) {
    let repoKey: string;
    try { repoKey = normalizeGitHubRepository(repositoryUrl).repoKey; }
    catch { return rejected("invalid_repository", 400); }
    if (!repos.includes(repoKey)) return rejected("forbidden", 403);
  }
  return null;
}
