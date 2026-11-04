/**
 * @ghfind/scoring — the public half of ghfind.
 *
 *   evidence (already-collected public GitHub data)
 *     └─ extract.ts      pure evidence -> RawMetrics derivation
 *   RawMetrics (types.ts, the cross-runtime wire contract)
 *     └─ score.ts        six dimensions + risk (risk.ts / legacy-risk.ts) -> Scoring
 *   Scoring
 *     └─ score-presentation.ts  weights, sub-score caps and the shared tier map
 *
 * Nothing here performs I/O. Collecting evidence from GitHub (API calls, token
 * pool, rate limiting, caching, persistence) is the private backend's job.
 */
export * from "./types";
export * from "./score";
export * from "./risk";
export * from "./rating";
export * from "./score-presentation";
export * from "./score-red-flags";
