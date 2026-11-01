import { ghFetch } from "@/lib/github";
import { getCachedGitHubX, setCachedGitHubX } from "@/lib/redis";

/** Public profile declaration only: never creates an ingestion/ownership binding. */
export async function githubProfileXUrl(githubId: string): Promise<string | null> {
  if (!/^[1-9]\d*$/.test(githubId)) return null;
  const cached = await getCachedGitHubX(githubId);
  if (cached !== undefined) return cached;
  try {
    const response = await ghFetch(`https://api.github.com/user/${githubId}`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const profile: unknown = await response.json();
    if (!profile || typeof profile !== "object" || !("id" in profile) || String(profile.id) !== githubId) return null;
    const handle = "twitter_username" in profile ? profile.twitter_username : null;
    const url = typeof handle === "string" && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : null;
    await setCachedGitHubX(githubId, url);
    return url;
  } catch {
    // Optional social link: timeout/rate limits must not hide the score card.
    return null;
  }
}
