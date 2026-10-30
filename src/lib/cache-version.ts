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
// v12 keeps language proficiency out of engineering judgments and roast targets.
export const ROAST_CACHE_VERSION = "v12";
/**
 * Roast copy generator, selected per deployment. `ROAST_GENERATOR=v13` runs the
 * multi-step copy chain (src/lib/roast-v13); anything else keeps the v12 single
 * call. The generator is an implementation detail of the current roast release:
 * reports stay stored and cached under ROAST_CACHE_VERSION, so flipping the flag
 * never marks existing reports stale (TS and Go readers keep agreeing). A roast
 * release bump in the manifest is the separate step that regenerates old reports.
 *
 * `ROAST_V13_SCOPE=background` limits the chain to queued auto re-roast jobs
 * (no viewer waiting); the default `all` also uses it for interactive roasts.
 * `foreground` is the interactive path that claims a durable RoastJob: the
 * page may wait, and generation continues after the browser leaves.
 */
export type RoastGenerator = "v12" | "v13";

/** Server-only: the roast generator for this request. */
export function roastGenerator(opts: { background?: boolean; foreground?: boolean } = {}): RoastGenerator {
  if (process.env.ROAST_GENERATOR !== "v13") return "v12";
  if (process.env.ROAST_V13_SCOPE === "background" && !opts.background && !opts.foreground) return "v12";
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
