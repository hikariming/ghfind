import { describe, expect, it } from "vitest";
import { applyOwnRepoCommunities, computeImpactFromContribMap, computeOwnRepoCommunityFacts, isEcosystemImpactPr, ownRepoCommunity, ownPrCommunityShare, type ContribRepoAgg, type OwnRepoCommunityRaw } from "../github";
import { score } from "../score";
import f from "./attributed-impact-fixture.json";

const repo: ContribRepoAgg = f.repo;
describe("attributed creator impact", () => {
  it("restores recorded creator metrics with attributed project included", () => {
    const facts = computeOwnRepoCommunityFacts(f.raw as OwnRepoCommunityRaw, f.context);
    expect(facts).toEqual(f.expected_facts);
    const community = ownRepoCommunity(facts);
    expect(facts.weighted_contributors).toBeGreaterThan(0);
    expect(facts.outside_merged_prs).toBe(3);
    expect(community).toBeGreaterThan(0);
    const repos = applyOwnRepoCommunities([repo], new Map([[repo.repo.toLowerCase(), facts]]), false);
    const impact = computeImpactFromContribMap(repos, "fixture-account-070");
    const result = score({ ...f.metrics, ...impact,
      impact_depth_raw: impact.impact_depth_raw + f.metrics.impact_depth_raw,
      external_merged_pr_count: 108 - 79,
      own_pr_community: ownPrCommunityShare(repos, "fixture-account-070", 79),
    });
    expect(score(f.metrics).final_score).toBe(67.6);
    expect(impact.impact_repos.map((r) => r.repo)).toContain(repo.repo);
    expect(isEcosystemImpactPr({ repo: repo.repo, repo_stars: 520, trivial: false, title: "fix", churn: 55, changed_files: 1 }, "fixture-account-070", repos)).toBe(true);
    // Community is a competing channel, never added to historical star depth.
    expect(impact.impact_depth_raw).toBe(1.83);
    expect(result.sub_scores.ecosystem_impact).toBeGreaterThan(2);
    expect(result.sub_scores.ecosystem_impact).toBeLessThanOrEqual(8.3);
    expect(result.final_score).toBeGreaterThan(score(f.metrics).final_score);
    console.log("Oct18 replay", { before: score(f.metrics).final_score, after: result.final_score, ecosystem: result.sub_scores.ecosystem_impact, community, impact });
  });

  it.each([
    ["empty self-created org", { forks: 0 }],
  ])("does not unlock stars for %s", (_, overrides) => {
    const r = { ...repo, ...overrides };
    expect(computeImpactFromContribMap([r], "fixture-account-070").impact_repo_count).toBe(0);
    expect(isEcosystemImpactPr({ repo: r.repo, repo_stars: 520, trivial: false, title: "fix", churn: 55, changed_files: 1 }, "fixture-account-070", [r])).toBe(false);
  });

  it("allows an outside human merge without ten forks, but not bot/self merges", () => {
    const facts = computeOwnRepoCommunityFacts(f.raw as OwnRepoCommunityRaw, f.context);
    expect(computeImpactFromContribMap([{ ...repo, forks: 0, community_facts: { ...facts, forks: 0 } }], "fixture-account-070").impact_repo_count).toBe(1);
    const raw = { ...f.raw, merged: f.raw.merged.map((p) => ({ ...p, author: "fixture-account-023[bot]", author_type: "Bot" })) };
    expect(computeOwnRepoCommunityFacts(raw, f.context).outside_merged_prs).toBe(0);
  });

  it("does not let docs-only PRs erase an established contributor", () => {
    const raw = { ...f.raw, merged: f.raw.merged.filter((p) => p.author === "fixture-account-058") };
    expect(computeOwnRepoCommunityFacts(raw, f.context).weighted_contributors).toBeGreaterThan(0);
  });

  it("propagates inflation even when community measurement is absent", () => {
    const repos = applyOwnRepoCommunities([repo], new Map(), true);
    expect(repos[0].star_inflation_severity).toBeGreaterThan(0);
    expect(repos[0].star_inflation_severity).toBeLessThan(1);
  });
});
