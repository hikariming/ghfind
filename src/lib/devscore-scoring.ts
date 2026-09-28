/**
 * The devscore result stored in every collection-v6 snapshot (the published
 * score stays v10 in this release; score v11 derives from this summary).
 * Pure: no I/O.
 */
import type { Developer } from "@/lib/devscore/model";
import type { Rated } from "@/lib/devscore/engine";
import type { DevscoreRepoFactors, DevscoreSummary } from "@/lib/types";

const TOP_REPOS = 10;

/** Compact, JSON-safe explanation of one `rateDeveloper` result. */
export function devscoreSummary(dev: Developer, rated: Rated): DevscoreSummary {
  const owned = new Map(dev.repos.map((r) => [r.name, r.owned]));
  const topRepos: DevscoreRepoFactors[] = rated.engine.repos
    .filter((r) => r.excluded === null)
    .slice(0, TOP_REPOS)
    .map((r) => ({
      name: r.name,
      owned: owned.get(r.name) ?? false,
      kind: r.kind,
      importance: r.importance,
      share: r.share,
      authorship: r.authorship,
      volume: r.volume,
      nature: r.nature,
      durability: r.durability,
      work: r.work,
      endorsement: r.endorsement,
      contrib: r.contrib,
      hype: r.hype,
    }));
  let reviews = 0;
  for (const repo of dev.repos) {
    for (const n of Object.values(repo.reviews_by_year ?? {})) reviews += n;
  }
  const { curve, engine, v3 } = rated;
  return {
    version: "v11",
    collected_at: dev.collected_at,
    v3: { score: v3.score, tier: v3.tier, remapped: v3.remapped, flags: { ...v3.flags } },
    curve: {
      score: curve.score,
      main: curve.main,
      content_bonus: curve.content_bonus,
      confidence: curve.confidence,
      e: curve.e,
      e_dev: curve.e_dev,
      e_maint: curve.e_maint,
      maint_flagship: curve.maint_flagship,
      maint_sustained: curve.maint_sustained,
      status: curve.status,
      flagship: curve.flagship,
      sustained: curve.sustained,
      recent_share: curve.recent_share,
    },
    engine: {
      score: engine.score,
      impact_score: engine.impact_score,
      breadth: engine.breadth,
      breadth_score: engine.breadth_score,
      longevity_years: engine.longevity_years,
      longevity_score: engine.longevity_score,
      collab_score: engine.collab_score,
      contrib: engine.contrib,
      contrib_score: engine.contrib_score,
      top_repos: topRepos,
    },
    reviews,
    followers: dev.followers,
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Structural check for a summary read back from an untrusted snapshot. */
export function isDevscoreSummary(value: unknown): value is DevscoreSummary {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<DevscoreSummary>;
  const flags = s.v3?.flags;
  return (
    s.version === "v11" &&
    finite(s.v3?.score) &&
    finite(s.v3?.remapped) &&
    ["lawanle", "npc", "renshangren", "dingji", "hang"].includes(String(s.v3?.tier)) &&
    !!flags &&
    [flags.slop, flags.influencer, flags.no_pr_data, flags.hype].every((f) => typeof f === "boolean") &&
    finite(s.curve?.sustained) &&
    finite(s.curve?.flagship) &&
    finite(s.curve?.e_maint) &&
    (s.curve?.recent_share === null || finite(s.curve?.recent_share)) &&
    ["high", "med", "low"].includes(String(s.curve?.confidence)) &&
    ["active", "maintaining", "inactive"].includes(String(s.curve?.status)) &&
    finite(s.engine?.impact_score) &&
    finite(s.engine?.contrib) &&
    (s.engine?.collab_score === null || finite(s.engine?.collab_score)) &&
    Array.isArray(s.engine?.top_repos) &&
    finite(s.reviews)
  );
}
