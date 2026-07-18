/**
 * Cache/archive versions for generated GitHub roast artifacts.
 *
 * Bump SCORE_CACHE_VERSION when deterministic scan metrics or scoring formulas
 * change. Bump ROAST_CACHE_VERSION when prompt/report generation semantics
 * change. Development bypasses these caches entirely so local prompt/scoring
 * edits are visible on the next request.
 */
// v7: star-engagement gate (top_repo_engagement_ratio) + prestige floor on
// max_impact_repo_stars (PRESTIGE_COMMIT_MIN / PRESTIGE_MERGED_PR_MIN).
export const SCORE_CACHE_VERSION = "v7";
export const ROAST_CACHE_VERSION = "v8";
/** Bump when the PK (versus) verdict prompt / output semantics change. */
export const VERDICT_CACHE_VERSION = "v1";

export function bypassGeneratedCaches(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.ENABLE_DEV_GENERATED_CACHE !== "1"
  );
}
