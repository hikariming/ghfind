import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeveloper, type ExtPr } from "../../model";
import type { Result as CurveResult } from "../curve";
import { rateDeveloper } from "../index";
import type { DevScore, RepoScore } from "../score";
import { detect, epoch, features, templated } from "../slop";
import { defaultParams as p, rate, squeeze, tierOf, type Result } from "../v3";
import { dev } from "./helpers";

const fixtures = join(import.meta.dirname, "fixtures");

describe("v3 caps and tiers", () => {
  const engineAt = (score: number): CurveResult => ({
    score, main: score, content_bonus: 0, confidence: "med", e: 0, e_dev: 0, e_maint: 0, maint_flagship: 0,
    maint_sustained: 0, status: "active", flagship: 0, sustained: 0, recent_share: null,
  });
  const noEngine: DevScore = {
    login: "u", score: 0, impact_score: 0, breadth: 0, breadth_score: 0, longevity_years: null, longevity_score: null,
    collab_score: null, contrib: 0, contrib_score: 0, repos: [],
  };

  it("reach without engineering is capped, graded by the remapped score; a strong own project lifts the cap", () => {
    const reach = dev({ login: "u", followers: 1500 });
    const r = rate(reach, noEngine, engineAt(60), p);
    expect(r.flags.influencer).toBe(true);
    expect(r.score).toBeLessThanOrEqual(p.infl_cap);
    expect(r.score).toBeGreaterThanOrEqual(p.cap_floor);
    expect(rate(reach, noEngine, engineAt(30), p).score).toBeLessThan(r.score);
    expect(squeeze(100, p.cap_floor, p.infl_cap)).toBeCloseTo(p.infl_cap, 9);
    const tool: RepoScore = {
      name: "u/tool", excluded: null, importance: 0.6, share: null, authorship: 0.9, volume: null, nature: null,
      durability: null, work: null, endorsement: null, contrib: 0, meaningful: false, kind: "code", active_months: null,
      forks: null, user_commits: null, user_rank: null, primary_language: null, engagement: null, age_years: null,
      review_depth: null, hype: false,
    };
    const built = rate(reach, { ...noEngine, repos: [tool] }, engineAt(60), p);
    expect(built.flags.influencer).toBe(false);
    expect(built.score).toBe(built.remapped);
    // no PR list (older data): no slop verdict, no cap
    expect(r.flags.no_pr_data).toBe(true);
    expect(r.flags.slop).toBe(false);
  });

  it("tier boundaries", () => {
    expect(tierOf(90)).toBe("hang");
    expect(tierOf(89.9)).toBe("dingji");
    expect(tierOf(70)).toBe("renshangren");
    expect(tierOf(40)).toBe("npc");
    expect(tierOf(39.9)).toBe("lawanle");
  });
});

describe("slop detector", () => {
  const pr = (repo: string, title: string, state: string, at: string, by: string | null): ExtPr => ({
    repo, title, state, created_at: at, additions: 0, deletions: 0, changed_files: 0,
    merged_by: state === "MERGED" ? by : null, closed_by: state === "CLOSED" ? by : null, reviewers: null,
  });

  it("templated titles", () => {
    expect(templated("fix: I have the complete toolkit covering iOS 13 through 17.3; My Telegram is @ MG7890")).toBe(true);
    expect(templated("feat: CLI tool fdfs_bulk_import (PR 2/4)")).toBe(false);
    expect(templated("Core bulk import, Part 2/4")).toBe(true);
    expect(templated("Add comprehensive validation - Fixes #105")).toBe(true);
    expect(templated("fix(ui): handle the case where the sidebar collapses while a long list is open")).toBe(true);
    expect(templated("fix: typo")).toBe(false);
    expect(templated("[2.x] fix: trim whitespace from sbt.version in build.properties")).toBe(false);
  });

  it("epoch", () => {
    expect(epoch("1970-01-01T00:00:00Z")).toBe(0);
    expect(epoch("1971-01-01T00:00:00Z")).toBe(86400 * 365);
    expect(epoch("2024-03-01T00:00:00Z") - epoch("2024-02-28T00:00:00Z")).toBe(2 * 86400);
  });

  it("spraying many repos with copied titles is slop; the same volume in a team repo is not", () => {
    const repos = ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6", "g/7", "h/8", "i/9", "j/10"];
    const title = "fix: the dashboard crashes when the export button is clicked twice";
    const list = Array.from({ length: 30 }, (_, i) =>
      pr(repos[i % repos.length], title, "CLOSED", `2026-06-${String(Math.floor(i / 3) + 1).padStart(2, "0")}T10:00:00Z`, "maint"),
    );
    list.push(pr("a/1", "real fix", "MERGED", "2026-05-01T10:00:00Z", "maint"));
    expect(detect(dev({ login: "u", ext_prs: list }))).toBe(true);
    const team = list.map((x) => ({ ...x, repo: "corp/app" }));
    team.push(pr("corp/app", "a", "MERGED", "2026-05-02T10:00:00Z", "u"), pr("corp/app", "b", "MERGED", "2026-05-03T10:00:00Z", "u"));
    expect(detect(dev({ login: "u", ext_prs: team }))).toBe(false);
    expect(detect(dev({ login: "u" }))).toBeNull();
  });

  it("rejections: maintainer-closed and abandoned count, superseded drafts do not", () => {
    const xs = [
      pr("o/r", "wip", "CLOSED", "2026-06-01T00:00:00Z", "u"), // superseded by "final"
      pr("o/r", "no thanks", "CLOSED", "2026-06-02T00:00:00Z", "maint"),
      pr("x/y", "abandoned", "CLOSED", "2026-06-03T00:00:00Z", "u"), // nothing merged in x/y
      pr("o/r", "final", "MERGED", "2026-06-05T00:00:00Z", "maint"),
    ];
    expect(features(dev({ login: "u", ext_prs: xs }))!.rejected).toBe(2);
  });
});

const rateFile = (path: string) => rateDeveloper(parseDeveloper(JSON.parse(readFileSync(path, "utf8"))));

describe("adversarial profiles (devscore src/testdata/adversarial)", () => {
  // Synthetic gamers in the data contract: each must stay far below a real
  // contributor with the same volume of independently merged work (ctl-endorsed).
  // adv-bot's 300 identical 03:00 commits per repo are stripped of commit_sizes to keep
  // the fixture small; its 2-line sampled commits alone keep it at the floor.
  const control = rateFile(join(fixtures, "adversarial/ctl-endorsed.json")).curve.score;
  for (const name of ["adv-influencer", "adv-starfarm", "adv-bot", "adv-prspam", "adv-ring"]) {
    it(`${name} stays low`, () => {
      const s = rateFile(join(fixtures, `adversarial/${name}.json`)).curve.score;
      expect(s).toBeLessThan(30);
      expect(s).toBeLessThan(control);
    });
  }
});

describe("parity with the Zig engine on real profiles", () => {
  // expected.json: `zig-out/bin/devscore --json` output (devscore e7a53f3) for these public profiles.
  const expected = JSON.parse(readFileSync(join(fixtures, "real/expected.json"), "utf8")) as Record<
    string,
    { v3: Result; curve: Pick<CurveResult, "score" | "main" | "e" | "confidence" | "status">; engine_score: number }
  >;
  const files = readdirSync(join(fixtures, "real")).filter((f) => f !== "expected.json");
  expect(files.sort()).toEqual(Object.keys(expected).sort());
  for (const file of files) {
    it(file, () => {
      const want = expected[file];
      const got = rateFile(join(fixtures, "real", file));
      expect(got.v3.tier).toBe(want.v3.tier);
      expect(got.v3.flags).toEqual(want.v3.flags);
      expect(got.curve.confidence).toBe(want.curve.confidence);
      expect(got.curve.status).toBe(want.curve.status);
      for (const [g, w] of [
        [got.v3.score, want.v3.score],
        [got.v3.remapped, want.v3.remapped],
        [got.curve.score, want.curve.score],
        [got.curve.main, want.curve.main],
        [got.curve.e, want.curve.e],
        [got.engine.score, want.engine_score],
      ]) {
        expect(Math.abs(g - w)).toBeLessThanOrEqual(1e-9);
      }
    });
  }
});
