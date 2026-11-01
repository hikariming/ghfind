import { readFileSync, readdirSync } from "node:fs";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { buildSql, loadImport } from "./deepseek-jobs-import.mts";
import { listJobSources } from "../src/lib/talent-match/store";

const imported = loadImport();
describe("official DeepSeek directional jobs", () => {
  it("accounts for all 37 entries, resolves redirects and deduplicates the Harness PM", () => {
    expect(imported.coverage).toHaveLength(37);
    expect(imported.roles).toHaveLength(70);
    expect(imported.coverage.filter((entry) => entry.kind === "redirect")).toHaveLength(3);
    expect(imported.roles.filter((role) => role.title.zh === "Agent Harness 产品经理")).toHaveLength(1);
    const product = imported.coverage.find((entry) => entry.title === "AI 产品经理")!;
    expect(product.roleIds).toContain("deepseek-8d40c764-product");
    expect(imported.roles.every((role) => /^https:\/\/app\.mokahr\.com\/social-recruitment\/high-flyer\/140576#\/job\/[\da-f-]+$/.test(role.applyUrl))).toBe(true);
  });

  it("keeps Harness research requirements out of engineering and design", () => {
    const role = (suffix: string) => imported.roles.find((r) => r.id === `deepseek-8d40c764-${suffix}`)!;
    expect(role("research").description).toContain("硕士学历及以上");
    expect(role("engineering").description).not.toContain("硕士学历及以上");
    expect(role("engineering").description).not.toContain("2年以上产品经理");
    expect(role("design").description).toContain("Figma");
    expect(role("project").description).toContain("每周在北京实习至少 5 天");
    expect(role("operations").description).toContain("SQL、Python");
  });

  it("isolates Code Agent specialties and pairs IDC responsibilities with the right qualifications", () => {
    const frontend = imported.roles.find((r) => r.id === "deepseek-a4ad8628-frontend")!;
    expect(frontend.description).toContain("3年以上前端");
    expect(frontend.description).not.toContain("3年以上移动端");
    expect(frontend.description).not.toContain("网络安全专项：");
    const onsite = imported.roles.find((r) => r.id === "deepseek-1c7e328d-onsite")!;
    expect(onsite.description).toContain("服务器、网络设备、存储");
    expect(onsite.description).not.toContain("熟悉供配电、暖通制冷");
  });

  it("migrates idempotently and exposes 70 distinct full JDs to requirement extraction", async () => {
    const db = createClient({ url: "file::memory:" });
    try {
      const dir = new URL("../migrations/", import.meta.url);
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql") && n < "0026").sort()) {
        await db.executeMultiple(readFileSync(new URL(name, dir), "utf8"));
      }
      const before = await db.execute("SELECT count(*) AS n FROM jobs WHERE company_id <> 'deepseek' AND status = 'open'");
      await db.executeMultiple(buildSql());
      await db.executeMultiple(buildSql());
      const open = await db.execute("SELECT id FROM jobs WHERE company_id = 'deepseek' AND status = 'open'");
      expect(open.rows).toHaveLength(70);
      expect(open.rows.some((r) => r.id === "deepseek-8d40c764")).toBe(false);
      const after = await db.execute("SELECT count(*) AS n FROM jobs WHERE company_id <> 'deepseek' AND status = 'open'");
      expect(after.rows).toEqual(before.rows);
      const sources = (await listJobSources(db, Date.now())).filter((j) => j.id.startsWith("deepseek-"));
      expect(sources).toHaveLength(70);
      const engineering = sources.find((j) => j.id === "deepseek-8d40c764-engineering")!;
      expect(engineering.text).toContain("Agent Harness Engineer");
      expect(engineering.text).toContain("参与开发 DeepSeek 的 Harness 产品");
      expect(engineering.text).not.toContain("硕士学历及以上");
      expect((await db.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    } finally { db.close(); }
  });
});
