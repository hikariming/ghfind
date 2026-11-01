import { createClient, type Client } from "@libsql/client";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExtractedRequirement, StoredProfile } from "../schema";
import {
  STALE_REPORT_MS,
  attachStars,
  deleteTalentData,
  findDoneReport,
  getOwnReport,
  getProfile,
  insertQueuedReport,
  listGrowthProjects,
  listJobSources,
  listMatchableJobs,
  listOwnReports,
  loadDimensions,
  loadVerifiedEvidence,
  monthFreeTokens,
  quotaCounts,
  setOptIn,
  updateReport,
  upsertJobRequirement,
  upsertProfile,
} from "../store";

async function migrate(db: Client, dir: string) {
  const url = new URL(`../../../../${dir}/`, import.meta.url);
  for (const name of readdirSync(url).filter((n) => n.endsWith(".sql")).sort()) {
    await db.executeMultiple(readFileSync(new URL(name, url), "utf8"));
  }
}

const core = createClient({ url: "file::memory:" });
const feed = createClient({ url: ":memory:" });
const NOW = Date.UTC(2026, 9, 12, 8);
const SCORE_VERSION = "v11";

const requirement: ExtractedRequirement = {
  title: { zh: "推理工程师", en: "Inference engineer" },
  direction: "ai",
  yearsMin: 3,
  location: "Beijing",
  employment: ["full_time"],
  mustHave: [{ id: "cuda", level: 3 }],
  niceToHave: [],
  degree: "none",
  research: "none",
};

const profile: StoredProfile = {
  login: "lin",
  name: "Lin",
  headline: { zh: "工程师", en: "Engineer" },
  direction: "ai",
  years: 4,
  skills: [{ id: "python", level: 3, evidence: "GitHub", source: "verified" }],
  experience: [],
  research: [],
  education: [],
  preferences: { location: "", remote: true, employment: [] },
};

beforeAll(async () => {
  await migrate(core, "migrations");
  await migrate(feed, "migrations-feed");
});
afterAll(() => {
  core.close();
  feed.close();
});
beforeEach(async () => {
  await core.executeMultiple("DELETE FROM talent_reports; DELETE FROM talent_match_profiles; DELETE FROM job_requirements;");
});

const report = (over: Partial<Parameters<typeof insertQueuedReport>[1]> = {}) => ({
  id: crypto.randomUUID(), githubId: 7, kind: "candidate" as const, inputHash: "h", byoKey: false, matchVersion: 1, now: NOW, ...over,
});

describe("report ledger", () => {
  it("allows one live report in flight, atomically", async () => {
    const first = report();
    expect(await insertQueuedReport(core, first)).toBe(true);
    expect(await insertQueuedReport(core, report())).toBe(false);
    expect(await quotaCounts(core, 7, NOW)).toEqual({ doneThisMonth: 0, inFlight: 1 });
    // Another user is unaffected.
    expect(await insertQueuedReport(core, report({ githubId: 8 }))).toBe(true);
  });

  it("fails a stale in-flight report so the owner is not locked out", async () => {
    const stuck = report();
    await insertQueuedReport(core, stuck);
    const later = NOW + STALE_REPORT_MS + 1;
    expect(await quotaCounts(core, 7, later)).toEqual({ doneThisMonth: 0, inFlight: 0 });
    expect(await insertQueuedReport(core, report({ now: later }))).toBe(true);
    expect((await getOwnReport(core, stuck.id, 7))?.status).toBe("failed");
    // The stale run cannot revive its row afterwards.
    await updateReport(core, stuck.id, { status: "done", now: later, result: { late: true } });
    expect(await getOwnReport(core, stuck.id, 7)).toMatchObject({ status: "failed", result: null });
  });

  it("counts done free reports this month, accumulates tokens, and finds reusable reports", async () => {
    const done = report({ inputHash: "same" });
    await insertQueuedReport(core, done);
    await updateReport(core, done.id, { status: "running", now: NOW, tokensIn: 100, tokensOut: 10 });
    await updateReport(core, done.id, { status: "done", now: NOW, result: { ok: 1 }, tokensIn: 50, tokensOut: 5 });
    const byo = report({ byoKey: true });
    await insertQueuedReport(core, byo);
    await updateReport(core, byo.id, { status: "done", now: NOW, tokensIn: 999 });

    expect(await quotaCounts(core, 7, NOW)).toEqual({ doneThisMonth: 1, inFlight: 0 });
    expect(await quotaCounts(core, 7, Date.UTC(2026, 10, 1))).toEqual({ doneThisMonth: 0, inFlight: 0 });
    expect(await monthFreeTokens(core, NOW)).toBe(165);
    expect(await findDoneReport(core, 7, "same", 1)).toBe(done.id);
    expect(await findDoneReport(core, 7, "same", 2)).toBeNull();

    const own = await getOwnReport(core, done.id, 7);
    expect(own).toMatchObject({ status: "done", result: { ok: 1 }, error: null });
    expect(await getOwnReport(core, done.id, 8)).toBeNull();
  });
});

describe("report history", () => {
  it("lists the owner's reports newest first with summaries of finished ones", async () => {
    const older = report({ now: NOW - 60_000 });
    await insertQueuedReport(core, older);
    await updateReport(core, older.id, { status: "failed", now: NOW - 60_000, error: "model_output_invalid" });
    const done = report();
    await insertQueuedReport(core, done);
    await updateReport(core, done.id, {
      status: "done",
      now: NOW,
      result: { profile: { headline: { zh: "工程师", en: "Engineer" } }, matches: [{ fit: 61 }, { fit: 82 }, { fit: 40 }] },
    });
    await insertQueuedReport(core, report({ githubId: 8 }));

    const history = await listOwnReports(core, 7);
    expect(history.map((h) => h.id)).toEqual([done.id, older.id]);
    expect(history[0]).toMatchObject({ status: "done", headline: { zh: "工程师", en: "Engineer" }, matchCount: 3, topFit: 82, error: null });
    expect(history[1]).toMatchObject({ status: "failed", headline: null, matchCount: 0, topFit: null, error: "model_output_invalid" });
    expect(await listOwnReports(core, 7, 1)).toHaveLength(1);
  });
});

describe("profiles", () => {
  it("upserts, keeps opt-in across updates, and deletes everything with vector ids", async () => {
    expect(await setOptIn(core, 7, true, NOW)).toBe(false);
    await upsertProfile(core, { githubId: 7, login: "lin", profile, inputHash: "a", vectorId: "talent:7", now: NOW });
    expect(await setOptIn(core, 7, true, NOW)).toBe(true);
    await upsertProfile(core, { githubId: 7, login: "lin", profile: { ...profile, years: 5 }, inputHash: "b", vectorId: "talent:7", now: NOW });
    expect(await getProfile(core, 7)).toEqual({ profile: { ...profile, years: 5 }, optedIn: true });

    await insertQueuedReport(core, report());
    expect(await deleteTalentData(core, 7)).toEqual(["talent:7"]);
    expect(await getProfile(core, 7)).toBeNull();
    expect(await quotaCounts(core, 7, NOW)).toEqual({ doneThisMonth: 0, inFlight: 0 });
  });
});

describe("jobs", () => {
  it("lists open jobs with their source text and only matchable ones once a requirement exists", async () => {
    const sources = await listJobSources(core, NOW);
    expect(sources.length).toBeGreaterThan(0);
    const job = sources[0];
    expect(job.storedHash).toBeNull();
    expect(job.text.length).toBeGreaterThan(0);
    expect(await listMatchableJobs(core, NOW)).toEqual([]);

    await upsertJobRequirement(core, { jobId: job.id, requirement, inputHash: "jh", vectorId: `job:${job.id}`, now: NOW });
    expect((await listJobSources(core, NOW)).find((s) => s.id === job.id)?.storedHash).toBe("jh");
    const [matchable] = await listMatchableJobs(core, NOW);
    expect(matchable).toMatchObject({ id: job.id, requirement });
    expect(matchable.title.zh && matchable.title.en).toBeTruthy();
    expect(await listMatchableJobs(core, NOW, [job.id, "missing"])).toHaveLength(1);
    expect(await listMatchableJobs(core, NOW, [])).toEqual([]);
  });
});

describe("evidence", () => {
  it("loads language shares, repo evidence and sub-scores for a login", async () => {
    await core.executeMultiple(`
      INSERT INTO developer_facets (username, facet_type, facet_value, weight) VALUES ('lin', 'language', 'Python', 62);
      INSERT INTO repos (repo_key, name_with_owner, owner_login, name, stars, language, topics, updated_at)
        VALUES ('vllm-project/vllm', 'vllm-project/vllm', 'vllm-project', 'vllm', 41200, 'Python', '["llm-serving"]', 0);
      INSERT INTO repo_developers (repo_key, username, relation, commits, prs, weight, updated_at)
        VALUES ('vllm-project/vllm', 'lin', 'contributor', 9, 4, 1, 0);
      INSERT INTO scores (username, final_score, tier, score_version, sub_scores, hidden, scanned_at)
        VALUES ('lin', 70, 'x', '${SCORE_VERSION}', '{"account_maturity": 8, "contribution_quality": 17}', 0, 0);
    `);
    expect(await loadVerifiedEvidence(core, "Lin")).toEqual({
      languages: [{ language: "Python", share: 62 }],
      repos: [{ nameWithOwner: "vllm-project/vllm", relation: "contributor", stars: 41200, language: "Python", topics: ["llm-serving"], prs: 4 }],
    });
    expect(await loadDimensions(core, "LIN", SCORE_VERSION)).toMatchObject({ account_maturity: 8, contribution_quality: 17, ecosystem_impact: 0 });
    expect((await loadDimensions(core, "nobody", SCORE_VERSION)).account_maturity).toBe(0);

    const candidates = await attachStars(core, [{ project: { repoKey: "vllm-project/vllm", fullName: "vllm-project/vllm", summary: "", language: "Python", topics: [], productScore: 1, stars: 0 }, closes: ["cuda"] }]);
    expect(candidates[0].project.stars).toBe(41200);
  });
});

describe("growth projects", () => {
  it("returns published, unmoderated Feed projects by product score", async () => {
    const insert = (key: string, score: number, published: number) => feed.execute({
      sql: `INSERT INTO feed_projects (repo_key, analysis_id, owner_login, name, canonical_url, summary, language, topics_json,
              project_type, lifecycle, product_score, confidence, verification_level, exposure_band, analyzed_at, risks_json,
              published, source_hash, projected_at)
            VALUES (?, 'a', ?, ?, '', 'summary', 'Python', '["cuda"]', 'library', 'active', ?, 1, 'x', 'x', 0, '[]', ?, 'h', 0)`,
      args: [key, key.split("/")[0], key.split("/")[1], score, published],
    });
    await insert("a/low", 0.2, 1);
    await insert("b/high", 0.9, 1);
    await insert("c/draft", 1, 0);
    await insert("d/removed", 0.95, 1);
    await feed.execute("INSERT INTO feed_project_moderation (repo_key, removed, updated_at) VALUES ('d/removed', 1, 0)");
    const projects = await listGrowthProjects(feed);
    expect(projects.map((p) => p.fullName)).toEqual(["b/high", "a/low"]);
    expect(projects[0]).toMatchObject({ topics: ["cuda"], language: "Python", stars: 0 });
  });
});
