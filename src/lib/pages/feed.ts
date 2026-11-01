import { listProjectBoard } from "@/lib/project-analysis-db";
import { hashString } from "@/lib/stream/rank";
import type { FeedPage } from "@/lib/social-feed/contract";
import type { StreamProjectPick, StreamVoice } from "@/lib/stream/types";

export interface FeedPageData {
  initialPage: FeedPage | null;
  voices: StreamVoice[];
  projects: StreamProjectPick[];
  generatedAt: number;
  initialError: string | null;
}

/** Posts are loaded by the public API after hydration so auth and eligibility
 * share one boundary. No X engagement metrics or demo posts enter this loader. */
export async function loadFeedPage(_locale: string): Promise<FeedPageData> {
  const now = Date.now();
  const candidates = await listProjectBoard("treasure", { limit: 30, offset: 0 }).catch((error: unknown) => {
    console.error("feed.source_failed daily_projects", error);
    return [];
  });
  // "Today" is the selection date, not the repository's release date.
  const day = new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const projects = candidates
    .sort((a, b) => hashString(`${day}:${a.repoKey}`) - hashString(`${day}:${b.repoKey}`) || a.repoKey.localeCompare(b.repoKey))
    .slice(0, 3)
    .map((project) => ({ repoKey: project.repoKey, summary: project.analysis.project.summary, href: project.analysis.repository.canonical_url }));
  return { initialPage: null, projects, voices: [], generatedAt: now, initialError: null };
}
