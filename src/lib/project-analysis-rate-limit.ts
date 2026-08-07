/**
 * Next-route-facing wrapper around the project-analysis rate limiter. The
 * backend-extraction-boundary test forbids `src/app` from importing
 * `@/lib/redis` directly, so the project-analyses API route reaches the
 * limiter through this module instead.
 */
export { checkProjectAnalysisRateLimit, rateLimitHeaders } from "@/lib/redis";
