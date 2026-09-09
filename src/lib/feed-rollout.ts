import { createHash } from "node:crypto";

type Environment = Record<string, string | undefined>;
export type FeedRolloutMode = "internal" | "percentage" | "all" | "paused";
export type FeedRoutingDecision =
  | { backend: "legacy" }
  | { backend: "unavailable" }
  | { backend: "go"; mode: FeedRolloutMode; internal: boolean };

const ROLLOUT_KEYS = [
  "FEED_ROLLOUT_MODE", "FEED_ROLLOUT_GITHUB_IDS", "FEED_ROLLOUT_SEED", "FEED_ROLLOUT_BASIS_POINTS",
] as const;

// Versioned and independent of request paths, cookies, login names and process
// randomness. Keep the seed fixed across internal -> 1% -> 10% -> all.
export function feedRolloutBucket(githubId: number, seed: string): number {
  return createHash("sha256").update(`ghfind-feed-rollout-v1\n${seed}\n${githubId}`).digest().readUInt32BE(0) % 10_000;
}

// This is admission to the Go runtime, not an alternative database writer.
// Unselected users receive an unavailable response: legacy GETs also write
// profiles and cannot safely share the writer-v2 privacy contract.
export function feedRoutingDecision(githubId: number, env: Environment = process.env): FeedRoutingDecision {
  const backend = env.FEED_BACKEND ?? "legacy";
  const configured = ROLLOUT_KEYS.some(key => env[key] !== undefined);
  if (backend === "legacy") return { backend: configured ? "unavailable" : "legacy" };
  if (backend !== "go" || !Number.isSafeInteger(githubId) || githubId <= 0) return { backend: "unavailable" };
  // Preserve explicitly enabled pre-rollout Go deployments. Production rollout
  // tooling supplies all four keys and must never remove them to roll back.
  if (!configured) return { backend: "go", mode: "all", internal: false };

  const mode = env.FEED_ROLLOUT_MODE;
  const seed = env.FEED_ROLLOUT_SEED;
  const rawIds = env.FEED_ROLLOUT_GITHUB_IDS;
  const rawPoints = env.FEED_ROLLOUT_BASIS_POINTS;
  if (!mode || !["internal", "percentage", "all", "paused"].includes(mode) ||
      !seed || !/^[A-Za-z0-9._:-]{16,128}$/.test(seed) ||
      rawIds === undefined || rawIds.length > 1024 ||
      !rawPoints || !/^(0|[1-9][0-9]{0,4})$/.test(rawPoints)) return { backend: "unavailable" };
  const ids = rawIds.split(",").map(value => value.trim());
  if (ids.length > 20 || ids.some(value => !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) ||
      new Set(ids).size !== ids.length) return { backend: "unavailable" };
  const points = Number(rawPoints);
  if ((mode === "internal" || mode === "paused") ? points !== 0 :
      mode === "all" ? points !== 10_000 : points < 1 || points >= 10_000) return { backend: "unavailable" };
  if (mode === "paused") return { backend: "unavailable" };
  const internal = ids.includes(String(githubId));
  if (mode === "all" || internal || (mode === "percentage" && feedRolloutBucket(githubId, seed) < points)) {
    return { backend: "go", mode: mode as FeedRolloutMode, internal };
  }
  return { backend: "unavailable" };
}
