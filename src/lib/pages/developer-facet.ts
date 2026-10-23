import type { FacetType } from "@/lib/facets";
import { getGoDevelopersByFacet, GO_DEVELOPERS_PER_FACET_LIMIT } from "@/lib/go-developers.server";
import { getGoProjectDetail } from "@/lib/go-projects.server";
import {
  getProjectAssessment,
  listTreasureHistory,
  ProjectAnalysisDatabaseError,
} from "@/lib/project-analysis-db";
import { decodeRouteParam } from "@/lib/route-params";

/** /developers/[type]/[...value] logic shared by the Next page and apps/web. */

const FACET_TYPES: FacetType[] = ["language", "org", "repo"];

export function parseFacetType(raw: string): FacetType | null {
  return (FACET_TYPES as string[]).includes(raw) ? (raw as FacetType) : null;
}

/** Rebuild the facet value from the catch-all path segments. A `repo` value is
 *  "owner/name" and so arrives as two segments (`/developers/repo/owner/name`) —
 *  a single dynamic segment would have %2F normalized away by the host and 404.
 *  language/org are single-segment. Each segment is decoded, then rejoined with
 *  "/" so it matches the stored `facet_value` exactly. */
export function facetValueFromSegments(segments: string[] | undefined): string {
  return (segments ?? []).map((s) => decodeRouteParam(s)).join("/");
}

type BucketHeadingKey =
  | "languageBucketHeading"
  | "orgBucketHeading"
  | "repoBucketHeading";

export function bucketHeadingKey(type: FacetType): BucketHeadingKey {
  if (type === "org") return "orgBucketHeading";
  if (type === "repo") return "repoBucketHeading";
  return "languageBucketHeading";
}

async function optionalProjectAssessment(type: FacetType, value: string) {
  if (type !== "repo") return { assessment: null, treasureHistory: [] };
  try {
    const assessment = await getProjectAssessment(value, { includeDelisted: false });
    const treasureHistory = assessment ? await listTreasureHistory(value) : [];
    return { assessment, treasureHistory };
  } catch (error) {
    if (error instanceof ProjectAnalysisDatabaseError) {
      return { assessment: null, treasureHistory: [] };
    }
    throw error;
  }
}

/** Path segment encoding that keeps a repo value's slash a separator (mirrors the sitemap). */
export function facetEncodedPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

/**
 * Bucket data, or null for an empty bucket (probed/garbage value, or one that
 * lost all members): thin content that 404s. Repo buckets with a real overview
 * but no listed devs still render (the header is substance).
 */
export async function loadDeveloperFacet(type: FacetType, value: string) {
  // Project pages lead with a repo header + contributor-quality summary. Only
  // repo buckets have a repo entity; language/org buckets skip it. Null when the
  // repo isn't in the graph yet — the page then degrades to the plain list.
  const projectPath = value.split("/");
  const [projectDetail, entries, projectAnalysis] = await Promise.all([
    type === "repo" && projectPath.length === 2
      ? getGoProjectDetail(projectPath[0], projectPath[1])
      : Promise.resolve(null),
    getGoDevelopersByFacet(type, value),
    optionalProjectAssessment(type, value),
  ]);
  const overview = projectDetail?.overview ?? null;
  const relatedProjects = projectDetail?.related ?? [];
  const { assessment, treasureHistory } = projectAnalysis;

  // An empty bucket (probed/garbage value, or one that lost all members) is
  // thin content: rendering it would pay an ISR write per path × locale for a
  // page nobody indexes. 404 instead; repo buckets with a real overview but no
  // listed devs still render (the header is substance).
  if (entries.length === 0 && !overview) return null;
  return { entries, overview, relatedProjects, assessment, treasureHistory, perFacetLimit: GO_DEVELOPERS_PER_FACET_LIMIT };
}
