import { z } from "zod";

export const RESUME_STORAGE_KEY = "ghfind.resumes.v1";
/**
 * Hard cap for the cloud-synced library payload (photos are the only bulky
 * field, ~700 KB each). D1 query parameters top out around 1 MB, so the API
 * rejects anything past this before it reaches the database.
 */
export const RESUME_LIBRARY_MAX_BYTES = 900_000;
export const TEMPLATE_IDS = ["editorial", "modern", "classic", "noir"] as const;
export const SECTION_TYPES = ["experience", "projects", "education", "skills", "custom"] as const;
const field = z.string().max(20000);
const entrySchema = z.object({ id: z.string(), title: field, subtitle: field, period: field, details: field });
export const resumeSchema = z.object({
  id: z.string(), name: field, template: z.enum(TEMPLATE_IDS), updatedAt: z.string(),
  cloudBase: z.object({ account: z.string(), updatedAt: z.string().nullable() }).optional(),
  photo: z.object({ data: z.string().max(700000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/), position: z.number().min(0).max(100) }).optional(),
  basics: z.object({ name: field, role: field, email: field, phone: field, city: field, website: field, summary: field }),
  sections: z.array(z.object({ id: z.string(), type: z.enum(SECTION_TYPES), title: field, entries: z.array(entrySchema).max(100) })).max(30),
});
const librarySchema = z.object({ version: z.literal(1), resumes: z.array(resumeSchema).max(100) });
export type Resume = z.infer<typeof resumeSchema>;
export type ResumeSection = Resume["sections"][number];
export type TemplateId = typeof TEMPLATE_IDS[number];
export type SectionType = typeof SECTION_TYPES[number];
export const sectionNames = {
  zh: { experience: "工作经历", projects: "项目经历", education: "教育背景", skills: "专业技能", custom: "自定义区块" },
  en: { experience: "Experience", projects: "Projects", education: "Education", skills: "Skills", custom: "Custom section" },
};
export function readResumeLibrary(raw: string | null): Resume[] {
  return raw === null ? [] : librarySchema.parse(JSON.parse(raw)).resumes;
}
export function upsertResume(resumes: Resume[], resume: Resume): Resume[] {
  const valid = resumeSchema.parse(resume);
  return [valid, ...resumes.filter(item => item.id !== valid.id)];
}
export function serializeResumeLibrary(resumes: Resume[]): string {
  return JSON.stringify(librarySchema.parse({ version: 1, resumes }));
}
export function emptyEntry() { return { id: crypto.randomUUID(), title: "", subtitle: "", period: "", details: "" }; }
export function newSection(type: SectionType, zh: boolean): ResumeSection {
  return { id: crypto.randomUUID(), type, title: sectionNames[zh ? "zh" : "en"][type], entries: [emptyEntry()] };
}
export function createResume(template: TemplateId, zh: boolean): Resume {
  return {
    id: crypto.randomUUID(), name: zh ? "我的简历" : "My résumé", template, updatedAt: "",
    basics: { name: "", role: "", email: "", phone: "", city: "", website: "", summary: "" },
    sections: [newSection("experience", zh), newSection("projects", zh), newSection("education", zh), newSection("skills", zh)],
  };
}
// Illustrative content appears only in template thumbnails, never in saved drafts.
export function sampleResume(template: TemplateId, zh: boolean): Resume {
  return { id: "sample", name: "Sample", template, updatedAt: "", basics: {
    name: zh ? "林予安" : "Alex Morgan", role: zh ? "产品工程师 / 全栈开发" : "Product Engineer", email: "hello@example.com", phone: "", city: zh ? "上海" : "London", website: "github.com/example",
    summary: zh ? "关注产品体验与工程质量，用清晰的设计和可靠的代码解决真实问题。" : "Building thoughtful products with a focus on clear design and reliable engineering.",
  }, sections: [
    { id: "sample-work", type: "experience", title: zh ? "工作经历" : "Experience", entries: [{ id: "sample-1", title: zh ? "产品工程师" : "Product Engineer", subtitle: zh ? "某科技公司 · 产品研发团队" : "Example Studio · Product team", period: "2022 — 2025", details: zh ? "负责核心产品的设计与开发，推动跨团队协作。\n建立组件规范，持续优化用户体验与交付效率。" : "Designed and shipped core product experiences.\nBuilt a shared component system with the design team." }] },
    { id: "sample-project", type: "projects", title: zh ? "项目经历" : "Projects", entries: [{ id: "sample-2", title: "Open Source Studio", subtitle: zh ? "开源协作工具 · 核心开发者" : "Open-source collaboration tool", period: "2024", details: zh ? "从用户研究到产品上线，完成一个轻量、易用的协作空间。" : "Built a lightweight collaborative workspace from research to release." }] },
    { id: "sample-education", type: "education", title: zh ? "教育背景" : "Education", entries: [{ id: "sample-3", title: zh ? "计算机科学与技术 · 本科" : "BSc Computer Science", subtitle: zh ? "某大学" : "Example University", period: "2018 — 2022", details: "" }] },
    { id: "sample-skills", type: "skills", title: zh ? "专业技能" : "Skills", entries: [{ id: "sample-4", title: "", subtitle: "", period: "", details: "TypeScript · React · Node.js · PostgreSQL\nProduct design · Figma · Git" }] },
  ] };
}

/** Compare document content independently of storage timestamps and local sync metadata. */
export function sameResumeContent(a: Resume, b: Resume): boolean {
  const content = (r: Resume) => ({ name: r.name, template: r.template, basics: r.basics, sections: r.sections, photo: r.photo });
  return JSON.stringify(content(a)) === JSON.stringify(content(b));
}

/** Normalize schema field order before comparing local storage snapshots. */
export function resumeStorageSnapshot(resume?: Resume): string {
  return serializeResumeLibrary(resume ? [resume] : []);
}
