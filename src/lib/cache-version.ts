/**
 * Cache/archive versions for generated GitHub roast artifacts.
 *
 * Bump SCORE_CACHE_VERSION when deterministic scan metrics or scoring formulas
 * change. Bump ROAST_CACHE_VERSION when prompt/report generation semantics
 * change. Development bypasses these caches entirely so local prompt/scoring
 * edits are visible on the next request.
 */
// v14 tightens signature-work quality signals so docs/site/example PR clusters
// are not presented as core substantive fixes.
export const SCORE_CACHE_VERSION = "v14";
// v30 aligns report wording with the tighter signature-work semantics.
export const ROAST_CACHE_VERSION = "v30";
/** Bump when the PK (versus) verdict prompt / output semantics change. */
export const VERDICT_CACHE_VERSION = "v1";

export function bypassGeneratedCaches(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.ENABLE_DEV_GENERATED_CACHE !== "1"
  );
}
