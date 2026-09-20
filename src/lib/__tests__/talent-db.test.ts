import { afterEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ batch: vi.fn(), execute: vi.fn(), close: vi.fn() }));
vi.mock("@libsql/client/web", () => ({ createClient: () => client }));
vi.mock("@/lib/d1-client", () => ({ getD1Binding: () => null }));
import { createPendingTalent, listPublishedTalents, resetTalentDbForTests } from "../talent-db";

afterEach(() => {
  resetTalentDbForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const publishedRow = {
  id: "bowenliang123",
  name: "梁博文 (Bowen Liang)",
  handle: "bowenliang123",
  role: "Apache Kyuubi PMC 成员",
  location: "广州",
  direction: "后端 / 基础设施",
  bio: "bio",
  skills_json: '["Java","Python"]',
  stars: 1707,
  contributions: null,
  source: "GitHub + 人工整理",
  project: "dsh-context",
  project_description: "插件",
  note: "note",
  available: 0,
  color: "blue",
  tags_json: null,
  projects_json: "[]",
  sources_json: "[]",
  public_fields_json: null,
  collection_slug: "bowen-liang",
  status: "published",
  sort_order: 10,
  created_at: 1,
  updated_at: 1,
};

it("lists only published talents, mapped to the directory shape", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema DDL
  client.execute.mockResolvedValueOnce({ rows: [publishedRow, { ...publishedRow, id: "x", status: "pending" }] });
  const talents = await listPublishedTalents();
  expect(client.execute.mock.calls[1][0].sql).toContain("status = 'published'");
  expect(talents).toHaveLength(2);
  const [talent] = talents;
  expect(talent.name).toBe("梁博文 (Bowen Liang)");
  expect(talent.initials).toBe("梁博");
  expect(talent.stars).toBe(1707);
  expect(talent.contributions).toBeNull();
  expect(talent.tags).toEqual(["后端 / 基础设施", "Java", "Python"]);
  expect(talent.pending).toBeUndefined();
});

it("stores intake submissions as pending without leaking non-public fields", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema DDL
  client.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });
  await createPendingTalent({
    id: "intake-1",
    name: " Alias ",
    handle: "octocat",
    initials: "AL",
    color: "sage",
    role: "开发者",
    location: "未公开",
    direction: "未分类",
    bio: "bio",
    skills: ["TypeScript"],
    stars: null,
    contributions: null,
    source: "人工整理",
    project: "",
    projectDescription: "",
    note: "推荐语",
    available: false,
    publicFields: { email: "hello@example.com" },
  });
  const insert = client.execute.mock.calls[1][0];
  expect(insert.sql).toContain("'pending'");
  expect(insert.args[1]).toBe("Alias");
  expect(JSON.stringify(insert.args)).toContain("hello@example.com");
  expect(JSON.stringify(insert.args)).not.toContain("projectDescription");
});

it("rejects name-less intake submissions", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
  client.execute.mockResolvedValueOnce({ rows: [] });
  await expect(
    createPendingTalent({ id: "x", name: "  " } as never),
  ).rejects.toThrow("name");
});
