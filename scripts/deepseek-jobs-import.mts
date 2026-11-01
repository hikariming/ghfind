/** Build the reviewed DeepSeek directional-job migration from the official snapshot.
 * Run: node --import tsx scripts/deepseek-jobs-import.mts
 * SQL is idempotent and scoped to DeepSeek; split parent URLs remain as archived
 * detail records. JobSyncWorkflow must run after applying it to refresh matching.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

interface SourceJob {
  id: string;
  title: string;
  url: string;
  paragraphs: string[];
  locations: { provinceName: string; cityName: string }[];
}
interface SplitRole {
  slug: string;
  title: { zh: string; en: string };
  ranges: [number, number | null][];
}
interface SplitGroup {
  commonParagraphs: number[];
  roles: SplitRole[];
  aliases?: { heading: string; targetId: string }[];
}
interface Plan { groups: Record<string, SplitGroup>; redirects: Record<string, string> }
export interface ImportedRole {
  id: string;
  sourceId: string;
  applyUrl: string;
  title: { zh: string; en: string };
  location: { zh: string; en: string };
  employment: string;
  description: string;
}
const ROOT = new URL("../", import.meta.url);
const SNAPSHOT = new URL("data/deepseek-jobs-2026-10-13.json", import.meta.url);
const PLAN = new URL("data/deepseek-job-splits-2026-10-13.json", import.meta.url);
const normalized = (text: string) => text.replace(/\ufeff/g, "").trim().replace(/\s+/g, " ");
const parentId = (id: string) => `deepseek-${id.slice(0, 8)}`;
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
const singleTitles: Record<string, string> = {
  "研发基础设施工程师": "Developer Infrastructure Engineer",
  "深度学习研发工程师": "Deep Learning Engineer",
  "多模态理解（数据/算法）研究员": "Multimodal Understanding Researcher (Data / Algorithms)",
  "后训练（数据/算法）研究员": "Post-training Researcher (Data / Algorithms)",
  "AGI核心业务管培生": "AGI Core Business Management Trainee",
  "法务团队": "Legal Team",
  "行政团队": "Administration Team",
  "Frontier（持续学习/自进化/新范式）研究员": "Frontier Researcher (Continual Learning / Self-evolution / New Paradigms)",
  "通用Agent数据产品经理（办公/生活/搜索）": "General Agent Data Product Manager (Office / Daily Life / Search)",
  "专业领域数据产品经理（小语种、医学法律等学科）": "Domain Data Product Manager (Languages / Medicine / Law)",
  "AI创作数据产品经理": "AI Creative Data Product Manager",
  "高性能算子/通信/编译器工程师": "High-performance Kernel / Communication / Compiler Engineer",
  "大模型训练/推理框架工程师": "LLM Training / Inference Framework Engineer",
  "测试开发工程师": "Software Development Engineer in Test",
  "情感智能数据产品经理": "Emotional Intelligence Data Product Manager",
  "AI跨界技术人才": "AI Interdisciplinary Technical Talent",
  "高性能分布式存储工程师": "High-performance Distributed Storage Engineer",
};

export function loadImport() {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { total: number; capturedAt: string; source: string; jobs: SourceJob[] };
  const plan = JSON.parse(readFileSync(PLAN, "utf8")) as Plan;
  if (snapshot.jobs.length !== snapshot.total || new Set(snapshot.jobs.map((j) => j.id)).size !== snapshot.total) throw new Error("Incomplete or duplicate official snapshot");
  const roles: ImportedRole[] = [];
  const coverage: { sourceId: string; title: string; roleIds: string[]; kind: string }[] = [];
  for (const job of snapshot.jobs) {
    const title = normalized(job.title);
    const places = [...new Set(job.locations.map((l) => l.provinceName === "北京市" ? "北京" : l.provinceName === "浙江" ? "杭州" : l.cityName.replace(/市$/, "")))];
    const location = { zh: places.join("、"), en: places.map((p) => ({ 北京: "Beijing", 杭州: "Hangzhou", 乌兰察布: "Ulanqab" })[p] ?? p).join(" / ") };
    const employment = job.paragraphs.some((p) => /实习/.test(p)) ? "full_time,intern" : "full_time";
    const redirect = plan.redirects[job.id];
    if (redirect) {
      coverage.push({ sourceId: job.id, title, roleIds: [redirect], kind: "redirect" });
      continue;
    }
    const group = plan.groups[job.id];
    const specs = group?.roles ?? [{ slug: "", title: { zh: title, en: singleTitles[title] }, ranges: [[0, null]] as [number, number | null][] }];
    const ids: string[] = [];
    for (const spec of specs) {
      if (!spec.title.en) throw new Error(`Missing English title: ${title}`);
      const indices = [...(group?.commonParagraphs ?? []), ...spec.ranges.flatMap(([start, end]) => {
        if (start < 0 || (end ?? job.paragraphs.length) > job.paragraphs.length || start >= (end ?? job.paragraphs.length)) throw new Error(`Invalid section range: ${title}/${spec.slug}`);
        return Array.from({ length: (end ?? job.paragraphs.length) - start }, (_, i) => start + i);
      })];
      const paragraphs = [...new Set(indices)].map((i) => {
        if (job.paragraphs[i] === undefined) throw new Error(`Missing source paragraph ${title}:${i}`);
        return normalized(job.paragraphs[i]);
      }).filter(Boolean);
      const body = paragraphs.map((p) => /^【[^】]+】$/.test(p) ? `### ${p.slice(1, -1)}` : p).join("\n\n");
      const id = `${parentId(job.id)}${spec.slug ? `-${spec.slug}` : ""}`;
      roles.push({ id, sourceId: job.id, applyUrl: job.url, title: spec.title, location, employment, description: `## ${spec.title.zh}\n\n${body}\n\n---\n\n[DeepSeek 官方职位详情](${job.url}) · 核对日期：${snapshot.capturedAt}\n\n${group ? "此记录按官方团队页的招聘方向拆分，申请时请注明方向。" : "职位内容来自官方招聘页。"}` });
      ids.push(id);
    }
    coverage.push({ sourceId: job.id, title, roleIds: [...ids, ...(group?.aliases?.map((a) => a.targetId) ?? [])], kind: group ? "split" : "single" });
  }
  const uniqueIds = new Set(roles.map((r) => r.id));
  if (uniqueIds.size !== roles.length) throw new Error("Role id collision");
  for (const entry of coverage) if (entry.roleIds.some((id) => !uniqueIds.has(id))) throw new Error(`Unresolved role alias: ${entry.title}`);
  return { snapshot, plan, roles, coverage };
}

export function buildSql(now = Date.parse("2026-10-13T23:30:00+08:00")) {
  const data = loadImport();
  const statements = ["-- Generated by scripts/deepseek-jobs-import.mts. Source: official DeepSeek recruitment, 2026-10-13.", "-- 37 source entries -> 70 canonical jobs. Run JobSyncWorkflow after applying for fresh requirements."];
  for (const source of data.snapshot.jobs) {
    if (!data.plan.groups[source.id] && !data.plan.redirects[source.id]) continue;
    // Retain old detail links, but exclude umbrella and redirect-only entries from matching.
    statements.push(`UPDATE jobs SET status = 'closed', updated_at = ${now} WHERE id = ${quote(parentId(source.id))} AND company_id = 'deepseek';`);
  }
  data.roles.forEach((role, index) => {
    statements.push(`INSERT INTO jobs (id, company_id, apply_url, employment_types, status, is_pinned, display_order, expires_at, created_at, updated_at)\nVALUES (${quote(role.id)}, 'deepseek', ${quote(role.applyUrl)}, ${quote(role.employment)}, 'open', 0, ${10 + index}, NULL, ${now}, ${now})\nON CONFLICT(id) DO UPDATE SET apply_url = excluded.apply_url, employment_types = excluded.employment_types, status = 'open', display_order = excluded.display_order, updated_at = excluded.updated_at;`);
    for (const locale of ["zh", "en"] as const) {
      const category = locale === "zh" ? "DeepSeek 招聘" : "DeepSeek Careers";
      const summary = locale === "zh" ? `${role.title.zh}；职责与要求见官方原文。` : `${role.title.en}. See the official job description for responsibilities and requirements.`;
      const description = locale === "zh" ? quote(role.description) : "NULL"; // Chinese official JD falls back through the existing locale rules.
      statements.push(`INSERT INTO job_translations (job_id, locale, title, category, location, salary, summary, description)\nVALUES (${quote(role.id)}, '${locale}', ${quote(role.title[locale])}, ${quote(category)}, ${quote(role.location[locale])}, NULL, ${quote(summary)}, ${description})\nON CONFLICT(job_id, locale) DO UPDATE SET title = excluded.title, category = excluded.category, location = excluded.location, summary = excluded.summary, description = excluded.description;`);
    }
  });
  return statements.join("\n\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = loadImport();
  writeFileSync(new URL("migrations/0026_deepseek_job_directions.sql", ROOT), buildSql());
  mkdirSync(new URL("output/", ROOT), { recursive: true });
  writeFileSync(new URL("output/deepseek-job-audit.json", ROOT), JSON.stringify({ source: data.snapshot.source, capturedAt: data.snapshot.capturedAt, officialEntries: data.snapshot.total, canonicalRoles: data.roles.length, coverage: data.coverage }, null, 2) + "\n");
  console.log(`${data.snapshot.total} official entries -> ${data.roles.length} canonical roles (${Object.keys(data.plan.groups).length} split pages, ${Object.keys(data.plan.redirects).length} redirects).`);
}
