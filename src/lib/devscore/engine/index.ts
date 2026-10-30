/**
 * devscore scoring engine (TypeScript port of devscore's Zig engine, round 28).
 * One module per Zig file: score (per-repo engine), curve (final score,
 * confidence, maintainer track), v3 (displayed score, caps, tiers), slop
 * (rule A detector). Pure functions; the collector produces the `Developer`.
 */
export { rateDeveloper, tierOf, TIER_LABEL, defaultParams as v3Params } from "./v3";
export type { Rated, Result as V3Result, Tier, Flags, Params as V3Params } from "./v3";
export { defaultParams as scoreParams, scoreDeveloper, isHype } from "./score";
export type { DevScore, RepoScore, Exclusion, Params as ScoreParams } from "./score";
export { defaultParams as curveParams } from "./curve";
export type { Result as CurveResult, Confidence, Status, Params as CurveParams } from "./curve";
export { defaultParams as slopParams } from "./slop";
export type { Params as SlopParams } from "./slop";
