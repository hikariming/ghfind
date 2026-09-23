import { afterEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ batch: vi.fn(), execute: vi.fn(), close: vi.fn() }));
vi.mock("@libsql/client/web", () => ({ createClient: () => client }));
vi.mock("@/lib/d1-client", () => ({ getD1Binding: () => null }));
import { createPendingTalent, listPublishedTalents, listTalentsPage, resetTalentDbForTests } from "../talent-db";

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
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema i18n ALTER
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema official_tags ALTER
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema pinned ALTER
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema corner_tag ALTER
  client.execute.mockResolvedValueOnce({ rows: [{ ...publishedRow, ghfind_score: 94.2 }, { ...publishedRow, id: "x", status: "pending" }] });
  const talents = await listPublishedTalents();
  expect(client.execute.mock.calls[5][0].sql).toContain("status = 'published'");
  expect(talents).toHaveLength(2);
  const [talent] = talents;
  expect(talent.name).toBe("梁博文 (Bowen Liang)");
  expect(talent.initials).toBe("梁博");
  expect(talent.stars).toBe(1707);
  expect(talent.contributions).toBeNull();
  expect(talent.score).toBe(94.2);
  expect(talents[1].score).toBeNull();
  expect(talent.tags).toEqual(["后端 / 基础设施", "Java", "Python"]);
  expect(talent.pending).toBeUndefined();
});

it("overlays English content for non-zh locales and falls back per field", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
  const i18nRow = {
    ...publishedRow,
    content_i18n_json: JSON.stringify({
      en: { role: "Apache Kyuubi PMC member", note: "en note", direction: "Backend / Infrastructure" },
    }),
  };
  for (const [locale, expectEn] of [["en", true], ["ja", true], [undefined, false], ["zh", false]] as const) {
    resetTalentDbForTests();
    vi.clearAllMocks();
    vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
    client.execute.mockResolvedValueOnce({ rows: [] });
    client.execute.mockResolvedValueOnce({ rows: [] });
    client.execute.mockResolvedValueOnce({ rows: [] });
    client.execute.mockResolvedValueOnce({ rows: [] });
    client.execute.mockResolvedValueOnce({ rows: [] });
    client.execute.mockResolvedValueOnce({ rows: [i18nRow] });
    const [talent] = await listPublishedTalents(locale);
    expect(talent.role).toBe(expectEn ? "Apache Kyuubi PMC member" : "Apache Kyuubi PMC 成员");
    expect(talent.note).toBe(expectEn ? "en note" : "note");
    // bio has no en override: falls back to the Chinese column either way.
    expect(talent.bio).toBe("bio");
    expect(talent.tags?.[0]).toBe(expectEn ? "Backend / Infrastructure" : "后端 / 基础设施");
  }
});

it("stores intake submissions as pending without leaking non-public fields", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema DDL
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema i18n ALTER
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema official_tags ALTER
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema pinned ALTER
  client.execute.mockResolvedValueOnce({ rows: [] }); // ensureSchema corner_tag ALTER
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
    score: null,
    source: "人工整理",
    project: "",
    projectDescription: "",
    note: "推荐语",
    available: false,
    publicFields: { email: "hello@example.com" },
  });
  const insert = client.execute.mock.calls[5][0];
  expect(insert.sql).toContain("'pending'");
  expect(insert.args[1]).toBe("Alias");
  expect(JSON.stringify(insert.args)).toContain("hello@example.com");
  expect(JSON.stringify(insert.args)).not.toContain("projectDescription");
});

function mockSchema() {
  for (let i = 0; i < 5; i++) client.execute.mockResolvedValueOnce({ rows: [] });
}

it("parses field-prefixed query tokens into targeted LIKE clauses", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
  mockSchema();
  client.execute.mockResolvedValueOnce({ rows: [{ n: 1 }] }); // count
  client.execute.mockResolvedValueOnce({ rows: [{ ...publishedRow, ghfind_score: null }] });
  await listTalentsPage({ query: "技能:Rust 地点:上海 前端" });
  const selectCall = client.execute.mock.calls[6][0];
  expect(selectCall.sql).toContain("t.skills_json LIKE ?");
  expect(selectCall.sql).toContain("t.location LIKE ?");
  expect(selectCall.sql).toContain("t.name LIKE ?");
  expect(JSON.stringify(selectCall.args)).toContain("%Rust%");
  expect(JSON.stringify(selectCall.args)).toContain("%上海%");
  expect(JSON.stringify(selectCall.args)).toContain("%前端%");
});

it("clamps out-of-range pages to the last page", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
  mockSchema();
  client.execute.mockResolvedValueOnce({ rows: [{ n: 30 }] }); // 2 pages at the default size
  client.execute.mockResolvedValueOnce({ rows: [{ ...publishedRow, ghfind_score: null }] });
  const result = await listTalentsPage({ page: 9 });
  expect(result.page).toBe(1);
  expect(result.pageSize).toBe(24);
  expect(result.hasMore).toBe(false);
  const selectCall = client.execute.mock.calls[6][0];
  expect(selectCall.args[selectCall.args.length - 2]).toBe(24); // LIMIT
  expect(selectCall.args[selectCall.args.length - 1]).toBe(24); // OFFSET = safePage * pageSize
});

it("rejects name-less intake submissions", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "file:test.db");
  client.execute.mockResolvedValueOnce({ rows: [] });
  client.execute.mockResolvedValueOnce({ rows: [] });
  client.execute.mockResolvedValueOnce({ rows: [] });
  client.execute.mockResolvedValueOnce({ rows: [] });
  client.execute.mockResolvedValueOnce({ rows: [] });
  await expect(
    createPendingTalent({ id: "x", name: "  " } as never),
  ).rejects.toThrow("name");
});
