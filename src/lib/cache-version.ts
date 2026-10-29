/**
 * Cache/archive versions for generated GitHub roast artifacts.
 *
 * Bump SCORE_CACHE_VERSION when deterministic scan metrics or scoring formulas
 * change. Bump ROAST_CACHE_VERSION when prompt/report generation semantics
 * change. Development bypasses these caches entirely so local prompt/scoring
 * edits are visible on the next request.
 */
// v19 saturates contribution quality and ecosystem impact on smooth curves.
// A few tiny pull requests, or every pull request in one repo, no longer fill those dimensions.
export const SCORE_CACHE_VERSION = "v19";
// v13 is the roast-cache release that pairs with the multi-step copy chain
// (src/lib/roast-v13). Opening a profile whose report is still on v12 marks it
// stale and enqueues on-view auto re-roast. The generator flag is separate:
// without ROAST_GENERATOR=v13 the regenerated report still uses the v12 single
// call, but is stored under ROAST_CACHE_VERSION=v13.
export const ROAST_CACHE_VERSION = "v13";
/**
 * Roast copy generator, selected per deployment. `ROAST_GENERATOR=v13` runs the
 * multi-step copy chain (src/lib/roast-v13); anything else keeps the v12 single
 * call. Reports are always stored under ROAST_CACHE_VERSION (currently v13).
 * Flipping the generator alone never changes the cache key; only a roast
 * release bump (this constant + the manifest) regenerates old reports.
 *
 * `ROAST_V13_SCOPE=background` limits the chain to queued auto re-roast jobs
 * (no viewer waiting); the default `all` also uses it for interactive roasts.
 */
export type RoastGenerator = "v12" | "v13";

/** Server-only: the roast generator for this request. */
export function roastGenerator(opts: { background?: boolean } = {}): RoastGenerator {
  if (process.env.ROAST_GENERATOR !== "v13") return "v12";
  if (process.env.ROAST_V13_SCOPE === "background" && !opts.background) return "v12";
  return "v13";
}

/** Bump when the PK (versus) verdict prompt / output semantics change. */
export const VERDICT_CACHE_VERSION = "v1";

export function bypassGeneratedCaches(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.ENABLE_DEV_GENERATED_CACHE !== "1"
  );
}
