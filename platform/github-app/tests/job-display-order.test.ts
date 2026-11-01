import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compareJobsByItem, JOB_ITEM_ORDER_SQL, JOINED_JOB_ITEM_ORDER_SQL, type DisplayJob } from "../src/job-display-order";

declare const TEST_SQL: string[];
const e = env as Env;
interface Fixture extends DisplayJob { installation?: number; kind?: "label" | "initialize" | "discover"; updated?: number; }
const make = (id: string, pr: number | null, created = 100, repository: number | null = 100): Fixture => ({ id, pr, created, repository, full_name: repository === null ? null : "owner/current" });
async function insert(fixtures: Fixture[]) {
  await e.DB.batch(fixtures.map(row => e.DB.prepare(`INSERT INTO jobs(id,installation,repository,full_name,pr,kind,created,due,updated)
    VALUES(?,?,?,?,?,?,?,0,?)`).bind(row.id, row.installation ?? 10, row.repository, row.full_name ?? null, row.pr,
      row.kind ?? "label", row.created, row.updated ?? 0)));
}
const read = async (limit = 100, offset = 0) => (await e.DB.prepare(`SELECT id,repository,full_name,pr,created FROM jobs
  WHERE installation=? AND repository=? ORDER BY ${JOB_ITEM_ORDER_SQL} LIMIT ? OFFSET ?`)
  .bind(10, 100, limit, offset).all<DisplayJob>()).results;
beforeAll(async () => { for (const sql of TEST_SQL) await e.DB.prepare(sql).run(); });
beforeEach(async () => { await e.DB.exec("DELETE FROM jobs;"); });

describe("GitHub item display order (#370)", () => {
  it("interleaves issues and PRs numerically and remains unchanged when parallel consumers finish out of order", async () => {
    await insert([
      { ...make("issue-100", 100), updated: 700 },
      { ...make("open-pr-2", 2), updated: 1000 },
      { ...make("issue-10", 10), updated: 100 },
      { ...make("issue-1", 1), updated: 800 },
    ]);
    const expected = ["issue-1", "open-pr-2", "issue-10", "issue-100"];
    expect((await read()).map(row => row.id)).toEqual(expected);
    await e.DB.prepare("UPDATE jobs SET state='done',updated=updated*-3+5000").run();
    expect((await read()).map(row => row.id)).toEqual(expected);
    expect((await read(2, 0)).map(row => row.id)).toEqual(expected.slice(0, 2));
    expect((await read(2, 2)).map(row => row.id)).toEqual(expected.slice(2));
  });

  it("orders repeated numbers by immutable admission and binary ID, then unnumbered operations without inventing dates", async () => {
    const fixtures = [make("z-later", 2, 200), make("z-earlier", 2, 100), make("a-earlier", 2, 100),
      make("legacy-zero-date", 2, 0), make("\u{10000}", 3), make("\uE000", 3),
      { ...make("initialize", null, 0), kind: "initialize" as const },
      { ...make("discover", null, 0), kind: "discover" as const }, make("legacy-zero-number", 0, 0)];
    await insert(fixtures);
    const ordered = await read();
    expect(ordered.map(row => row.id)).toEqual(["legacy-zero-date", "a-earlier", "z-earlier", "z-later", "\uE000", "\u{10000}", "discover", "initialize", "legacy-zero-number"]);
    expect([...fixtures].reverse().sort(compareJobsByItem).map(row => row.id)).toEqual(ordered.map(row => row.id));
  });

  it("groups same-owner renamed history by current canonical repository and paginates before merging without gaps", async () => {
    const fixtures: Fixture[] = [];
    for (let number = 30; number >= 1; number--) {
      fixtures.push({ ...make(`alpha-${number}`, number, number, 200), full_name: number % 2 ? "Owner/old-name" : "owner/new-name", updated: number * 100 });
      fixtures.push({ ...make(`beta-${number}`, number, number, 100), full_name: "owner/beta", updated: 10000 - number });
    }
    fixtures.push({ ...make("no-repository-discover", null, 0, null), kind: "discover" });
    await insert(fixtures);
    const joined = async (limit = 25, offset = 0) => (await e.DB.prepare(`WITH permitted(repository,fullName) AS (VALUES(?,?),(?,?))
      SELECT j.id,j.repository,j.full_name,p.fullName,j.pr,j.created FROM jobs j JOIN permitted p ON p.repository=j.repository
      WHERE j.installation=? ORDER BY lower(p.fullName) ASC,j.repository ASC,${JOINED_JOB_ITEM_ORDER_SQL} LIMIT ? OFFSET ?`)
      .bind(200, "owner/Alpha", 100, "owner/beta", 10, limit, offset).all<DisplayJob>()).results;
    const pages = [...await joined(25, 0), ...await joined(25, 25), ...await joined(25, 50)];
    expect(pages).toHaveLength(60); expect(new Set(pages.map(row => row.id)).size).toBe(60);
    expect(pages.map(row => row.id)).toEqual([...Array.from({ length: 30 }, (_, n) => `alpha-${n + 1}`), ...Array.from({ length: 30 }, (_, n) => `beta-${n + 1}`)]);
    expect([...pages].reverse().sort(compareJobsByItem).map(row => row.id)).toEqual(pages.map(row => row.id));
    expect([...pages, fixtures.at(-1)!].reverse().sort(compareJobsByItem).at(-1)?.id).toBe("no-repository-discover");
  });

  it("keeps installation/repository filtering ahead of the bounded number-ordered page", async () => {
    await insert([make("visible-10", 10), make("visible-20", 20), { ...make("other-installation-1", 1), installation: 20 }, make("other-repository-2", 2, 0, 200)]);
    expect((await read(1, 0)).map(row => row.id)).toEqual(["visible-10"]);
    expect((await read(1, 1)).map(row => row.id)).toEqual(["visible-20"]);
  });
});
