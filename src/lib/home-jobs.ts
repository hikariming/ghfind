/**
 * Homepage "developer hiring" band. Listings are hand-curated here until a
 * job board backend exists; sponsored listings render first with a badge.
 * Text is per-locale with an English fallback.
 */
export type JobText = { en: string; zh?: string };

export type HomeJob = {
  id: string;
  company: string;
  /** Square logo under /public or an absolute URL; falls back to the initial. */
  logo?: string;
  title: JobText;
  salary: JobText;
  location: JobText;
  tags: string[];
  /** Where the card links: the company's job post or apply page. */
  href: string;
  sponsored?: boolean;
};

// TODO: placeholder listings mirroring the design mock — replace with real
// sponsor jobs before release.
export const HOME_JOBS: HomeJob[] = [
  {
    id: "xinghe-frontend",
    company: "星河科技",
    title: { en: "Senior Frontend Engineer", zh: "高级前端工程师" },
    salary: { en: "¥30–50K · 16 months", zh: "30–50K · 16薪" },
    location: { en: "Shanghai / Remote · 3–5 yrs", zh: "上海 / 远程 · 3–5年" },
    tags: ["React", "TypeScript"],
    href: "/contact",
    sponsored: true,
  },
  {
    id: "yunzhan-ai-platform",
    company: "云栈科技",
    title: { en: "AI Platform Engineer", zh: "AI 平台工程师" },
    salary: { en: "¥40–70K · 15 months", zh: "40–70K · 15薪" },
    location: { en: "Beijing · 3–5 yrs", zh: "北京 · 3–5年" },
    tags: ["Python", "LLM"],
    href: "/contact",
    sponsored: true,
  },
  {
    id: "kaiyuan-fullstack",
    company: "开源工坊",
    title: { en: "Full-stack Engineer", zh: "全栈开发工程师" },
    salary: { en: "¥25–40K · 14 months", zh: "25–40K · 14薪" },
    location: { en: "Hangzhou / Remote · 1–3 yrs", zh: "杭州 / 远程 · 1–3年" },
    tags: ["Node.js", "React"],
    href: "/contact",
  },
  {
    id: "jijian-backend",
    company: "极简软件",
    title: { en: "Backend Engineer", zh: "后端工程师" },
    salary: { en: "¥25–45K · 15 months", zh: "25–45K · 15薪" },
    location: { en: "Shenzhen · 3–5 yrs", zh: "深圳 · 3–5年" },
    tags: ["Go", "Kubernetes"],
    href: "/contact",
  },
];

export function jobText(text: JobText, locale: string): string {
  return (locale === "zh" && text.zh) || text.en;
}

/** Sponsored first, then curated order; four fill one desktop row. */
export function homeJobs(limit = 4): HomeJob[] {
  return [...HOME_JOBS]
    .sort((a, b) => Number(Boolean(b.sponsored)) - Number(Boolean(a.sponsored)))
    .slice(0, limit);
}
