/**
 * Cache/archive versions for generated GitHub roast artifacts.
 *
 * Bump SCORE_CACHE_VERSION when deterministic scan metrics or scoring formulas
 * change. Bump ROAST_CACHE_VERSION when prompt/report generation semantics
 * change. Development bypasses these caches entirely so local prompt/scoring
 * edits are visible on the next request.
 */
// Formal successor to the restored v10 contract. v13 = v10 + own-project
// community credit (`6·A·logRatio(own, 200)`). v11/v12 labels stay retired.
export const SCORE_CACHE_VERSION = "v13";
// v12 keeps language proficiency out of engineering judgments and roast targets.
export const ROAST_CACHE_VERSION = "v12";
/** Bump when the PK (versus) verdict prompt / output semantics change. */
export const VERDICT_CACHE_VERSION = "v1";

export function bypassGeneratedCaches(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.ENABLE_DEV_GENERATED_CACHE !== "1"
  );
}
