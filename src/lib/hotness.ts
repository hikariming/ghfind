export interface TrendingCandidate {
  username: string;
  final_score: number;
  lookup_count: number;
  recent_lookup_count: number;
  last_lookup_at: number | null;
}

const SCORE_WEIGHT = 0.8;
const RECENT_HEAT_WEIGHT = 0.15;
const RECENCY_WEIGHT = 0.05;
const HEAT_SATURATION_COUNT = 20;
const DECAY_WINDOW_HOURS = 24 * 7;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function recentHeatScore(recentLookupCount: number): number {
  const count = Math.max(0, Math.floor(recentLookupCount));
  return clamp(
    (Math.log1p(count) / Math.log1p(HEAT_SATURATION_COUNT)) * 100,
    0,
    100,
  );
}

function recencyScore(lastLookupAt: number | null, now: number): number {
  if (!lastLookupAt || !Number.isFinite(lastLookupAt)) return 0;
  const ageHours = Math.max(0, (now - lastLookupAt) / (60 * 60 * 1000));
  return Math.exp(-ageHours / DECAY_WINDOW_HOURS) * 100;
}

export function computeTrendingScore(
  candidate: TrendingCandidate,
  now = Date.now(),
): number {
  const score = clamp(candidate.final_score, 0, 100);
  return (
    score * SCORE_WEIGHT +
    recentHeatScore(candidate.recent_lookup_count) * RECENT_HEAT_WEIGHT +
    recencyScore(candidate.last_lookup_at, now) * RECENCY_WEIGHT
  );
}

export function rankTrending<T extends TrendingCandidate>(
  candidates: T[],
  now = Date.now(),
): T[] {
  return [...candidates].sort((a, b) => {
    const byTrend = computeTrendingScore(b, now) - computeTrendingScore(a, now);
    if (byTrend !== 0) return byTrend;
    const byScore = b.final_score - a.final_score;
    if (byScore !== 0) return byScore;
    const byHeat = b.lookup_count - a.lookup_count;
    if (byHeat !== 0) return byHeat;
    return a.username.localeCompare(b.username);
  });
}
