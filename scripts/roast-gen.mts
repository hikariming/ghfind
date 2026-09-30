/**
 * Deterministic, hand-authored bilingual roast generator.
 *
 * This is NOT an LLM call — every sentence pattern below is written by hand and
 * slot-filled with the account's real metrics (devscore-derived sub-scores, top repos,
 * PR counts, red flags, orgs). Used by mega-ingest.mts to evaluate large batches
 * of developers without depending on a configured LLM provider.
 *
 * Variant selection is a stable hash of the username (not Math.random), so
 * re-running the ingest for the same person reproduces the same text.
 */
import { aggregateLanguages } from "../src/lib/profile-insights";
import type { ImpactRepo, RawMetrics, Scoring, SubScoreKey, TopRepo, Tags, RoastLine } from "../src/lib/types";
import { SUBSCORE_MAX } from "../src/lib/score-presentation";

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function pick<T>(arr: T[], seed: number, salt: number): T {
  return arr[(seed + salt) % arr.length];
}

interface Ctx {
  username: string;
  displayName: string | null;
  m: RawMetrics;
  scoring: Scoring;
  topRepos: TopRepo[];
  impactRepos: ImpactRepo[];
  orgs: string[];
  orgDisplay: string; // capitalized primary org for this ingest pass
  topLang: string | null;
  bestRepo: TopRepo | null;
  bestImpact: ImpactRepo | null;
  seed: number;
}

export function buildCtx(input: {
  username: string;
  displayName: string | null;
  m: RawMetrics;
  scoring: Scoring;
  topRepos: TopRepo[];
  impactRepos: ImpactRepo[];
  orgs: string[];
  orgDisplay: string;
}): Ctx {
  const langs = aggregateLanguages(input.topRepos, 3);
  const bestRepo = [...input.topRepos].sort((a, b) => b.stars - a.stars)[0] ?? null;
  const bestImpact = [...input.impactRepos].sort((a, b) => b.stars - a.stars)[0] ?? null;
  return {
    ...input,
    topLang: langs[0]?.name ?? bestRepo?.language ?? null,
    bestRepo,
    bestImpact,
    seed: hashOf(input.username.toLowerCase()),
  };
}

function dominantDimension(scoring: Scoring): SubScoreKey {
  const entries = Object.entries(scoring.sub_scores) as [SubScoreKey, number][];
  return entries.sort((a, b) => b[1] / SUBSCORE_MAX[b[0]] - a[1] / SUBSCORE_MAX[a[0]])[0][0];
}
function weakestDimension(scoring: Scoring): SubScoreKey {
  const entries = Object.entries(scoring.sub_scores) as [SubScoreKey, number][];
  return entries.sort((a, b) => a[1] / SUBSCORE_MAX[a[0]] - b[1] / SUBSCORE_MAX[b[0]])[0][0];
}

const DIM_LABEL_ZH: Record<SubScoreKey, string> = {
  account_maturity: "账号成熟度",
  original_project_quality: "原创项目质量",
  contribution_quality: "贡献质量",
  ecosystem_impact: "生态影响力",
  community_influence: "社区影响力",
  activity_authenticity: "活跃真实性",
};
const DIM_LABEL_EN: Record<SubScoreKey, string> = {
  account_maturity: "Account Maturity",
  original_project_quality: "Original Project Quality",
  contribution_quality: "Contribution Quality",
  ecosystem_impact: "Ecosystem Impact",
  community_influence: "Community Influence",
  activity_authenticity: "Activity Authenticity",
};

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const TIER_TAG: Record<string, { zh: string; en: string }> = {
  "夯": { zh: "封神选手", en: "Hall of Famer" },
  "顶级": { zh: "一线开发者", en: "Top-Tier Dev" },
  "人上人": { zh: "可信贡献者", en: "Trusted Contributor" },
  "NPC": { zh: "潜力观察", en: "Under the Radar" },
  "拉完了": { zh: "水分较大", en: "Low Signal" },
};
const DIM_TAG: Record<SubScoreKey, { zh: string; en: string }> = {
  account_maturity: { zh: "老账号", en: "Veteran Account" },
  original_project_quality: { zh: "项目缔造者", en: "Project Builder" },
  contribution_quality: { zh: "PR 老手", en: "PR Veteran" },
  ecosystem_impact: { zh: "生态贡献者", en: "Ecosystem Contributor" },
  community_influence: { zh: "社区红人", en: "Community Star" },
  activity_authenticity: { zh: "肝帝在线", en: "Daily Grinder" },
};

export function buildTags(ctx: Ctx): Tags {
  const zh = new Set<string>();
  const en = new Set<string>();
  const tierTag = TIER_TAG[ctx.scoring.tier] ?? TIER_TAG.NPC;
  zh.add(tierTag.zh);
  en.add(tierTag.en);

  const dom = dominantDimension(ctx.scoring);
  zh.add(DIM_TAG[dom].zh);
  en.add(DIM_TAG[dom].en);

  if (ctx.topLang) {
    zh.add(`${ctx.topLang} 专精`);
    en.add(`${ctx.topLang} Specialist`);
  }
  if (ctx.orgDisplay) {
    zh.add(`${ctx.orgDisplay} 一员`);
    en.add(`${ctx.orgDisplay} Member`);
  }
  if (ctx.scoring.red_flags.length >= 2) {
    zh.add("刷量嫌疑");
    en.add("Farming Suspect");
  } else if ((ctx.m.max_impact_repo_stars ?? 0) >= 10000) {
    zh.add("顶级仓库贡献者");
    en.add("Marquee Repo Contributor");
  }
  return { zh: [...zh].slice(0, 5), en: [...en].slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Roast one-liner
// ---------------------------------------------------------------------------

const ROAST_LINE_BANK: Record<string, { zh: string[]; en: string[] }> = {
  "夯": {
    zh: [
      "分数封顶,{repo} 这种项目不是随便谁都能攒出来的,建议直接颁个终身成就奖。",
      "{stars} star 的仓库压阵,这已经不是「有实力」而是「行业标杆」级别了。",
      "翻遍数据找不出一个能喷的点,只能说这是来结算 KPI 的,不是来交作业的。",
    ],
    en: [
      "A project like {repo} doesn't happen by accident — this is a certified industry benchmark, not a side hustle.",
      "With {stars} stars behind them, calling this account \"skilled\" undersells it — it's a landmark.",
      "Combed through every metric looking for a weak point and came up empty. This one's here to collect trophies.",
    ],
  },
  "顶级": {
    zh: [
      "{merged} 个合并 PR 摆在那,{repo} 也扛得住,已经是能被同行认出来的水平了。",
      "生态影响力拉满,{repo}({stars} star)不是白混的,继续这个节奏冲一线没问题。",
      "账号活得又久又干净,{merged} PR 全是真功夫,唯一的问题是还差临门一脚。",
    ],
    en: [
      "{merged} merged PRs and a project like {repo} to back it up — this is someone peers already recognize.",
      "Ecosystem impact is strong; {repo} at {stars} stars isn't a fluke, and the trajectory points straight to top-tier.",
      "Long-lived, clean account with {merged} real merged PRs — just one more push from the very top tier.",
    ],
  },
  "人上人": {
    zh: [
      "{merged} 个合并 PR,靠谱是靠谱,但离「封神」还差一口气,继续肝。",
      "{repo} 这个项目撑得起门面,社区影响力再补一补就能往上一个档次冲。",
      "数据挑不出硬伤,就是还没到让人眼前一亮的程度,踏实型选手。",
    ],
    en: [
      "{merged} merged PRs — solid and trustworthy, just one gear short of legendary. Keep grinding.",
      "{repo} carries the profile just fine; a bit more community pull and this jumps a tier.",
      "Nothing broken in the data, just nothing that makes you sit up either — a steady, dependable operator.",
    ],
  },
  "NPC": {
    zh: [
      "账号活跃了 {years} 年,但存在感约等于路人甲,数据说明一切。",
      "有代码,有提交,但{repo}撑不起排面,继续加油别摆烂。",
      "不算差也算不上好,典型的「查得到但记不住」型账号。",
    ],
    en: [
      "Active for {years} years, but the footprint reads like a background character. The numbers speak for themselves.",
      "Code exists, commits exist, but nothing here (including {repo}) is carrying the profile yet.",
      "Not bad, not good — the textbook \"found but forgotten\" account.",
    ],
  },
  "拉完了": {
    zh: [
      "红旗插了 {flags} 面,这数据画风不太对劲,建议先把水分挤一挤。",
      "followers/following 比例、提交模式都对不上「正常开发者」的曲线,谨慎围观。",
      "翻了半天没找到能拿得出手的原创项目,这个分数是数据自己给出来的,不冤。",
    ],
    en: [
      "{flags} red flags raised — the pattern here doesn't look like a normal contributor curve. Proceed with caution.",
      "Follower ratio and commit pattern both deviate from what a genuine dev account looks like.",
      "No original project worth pointing to after a full pass — the low score isn't an accident, the data earned it.",
    ],
  },
};

export function buildRoastLine(ctx: Ctx): RoastLine {
  const bank = ROAST_LINE_BANK[ctx.scoring.tier] ?? ROAST_LINE_BANK.NPC;
  const repo = ctx.bestRepo?.name.split("/").pop() ?? ctx.bestImpact?.repo.split("/").pop() ?? "自己的项目";
  const repoEn = ctx.bestRepo?.name ?? ctx.bestImpact?.repo ?? "their own project";
  const stars = ctx.bestRepo?.stars ?? ctx.bestImpact?.stars ?? ctx.m.max_stars ?? 0;
  const fill = (s: string, repoName: string) =>
    s
      .replace("{repo}", repoName)
      .replace("{stars}", String(stars))
      .replace("{merged}", String(ctx.m.merged_pr_count))
      .replace("{years}", String(ctx.m.contribution_years_active))
      .replace("{flags}", String(ctx.scoring.red_flags.length));
  return {
    zh: fill(pick(bank.zh, ctx.seed, 0), repo),
    en: fill(pick(bank.en, ctx.seed, 0), repoEn),
  };
}

// ---------------------------------------------------------------------------
// Full report
// ---------------------------------------------------------------------------

function pct(sub: number, key: SubScoreKey): number {
  return Math.round((sub / SUBSCORE_MAX[key]) * 100);
}

function maturityLine(ctx: Ctx, lang: "zh" | "en"): string {
  const { m } = ctx;
  const p = pct(ctx.scoring.sub_scores.account_maturity, "account_maturity");
  if (lang === "zh") {
    return `账号 ${m.account_age_years.toFixed(1)} 年账龄,活跃跨度 ${m.contribution_years_active} 年,成熟度得分打到 ${p}%。`;
  }
  return `Account age ${m.account_age_years.toFixed(1)} years, active across ${m.contribution_years_active} year(s) — maturity lands at ${p}%.`;
}

function projectQualityLine(ctx: Ctx, lang: "zh" | "en"): string {
  const { m, bestRepo } = ctx;
  const p = pct(ctx.scoring.sub_scores.original_project_quality, "original_project_quality");
  if (m.nonempty_original_repo_count === 0) {
    return lang === "zh"
      ? "没有任何非空原创仓库,原创项目质量直接挂零。"
      : "Zero non-empty original repositories — original project quality bottoms out at zero.";
  }
  const repoName = bestRepo?.name ?? "—";
  if (lang === "zh") {
    return `最拿得出手的原创项目是 ${repoName}(${bestRepo?.stars ?? 0} star),原创项目质量 ${p}%。`;
  }
  return `Best original project is ${repoName} (${bestRepo?.stars ?? 0} stars) — original project quality at ${p}%.`;
}

function contributionLine(ctx: Ctx, lang: "zh" | "en"): string {
  const { m } = ctx;
  const p = pct(ctx.scoring.sub_scores.contribution_quality, "contribution_quality");
  const rejectPct = Math.round((m.pr_rejection_rate ?? 0) * 100);
  if (lang === "zh") {
    return `累计 ${m.merged_pr_count} 个合并 PR(总提交 ${m.total_pr_count} 个,驳回率约 ${rejectPct}%),贡献质量 ${p}%。`;
  }
  return `${m.merged_pr_count} merged PRs out of ${m.total_pr_count} submitted (rejection rate ~${rejectPct}%) — contribution quality at ${p}%.`;
}

function ecosystemLine(ctx: Ctx, lang: "zh" | "en"): string {
  const { m, bestImpact } = ctx;
  const p = pct(ctx.scoring.sub_scores.ecosystem_impact, "ecosystem_impact");
  if (!bestImpact || m.max_impact_repo_stars === 0) {
    return lang === "zh"
      ? `没有查到进入过热门项目(高星仓库)的实质性 PR,生态影响力 ${p}%。`
      : `No material contributions found into any high-star repository — ecosystem impact at ${p}%.`;
  }
  if (lang === "zh") {
    return `在 ${bestImpact.repo}(${bestImpact.stars} star)贡献了 ${bestImpact.prs} 个 PR / ${bestImpact.commits} 次提交,生态影响力 ${p}%。`;
  }
  return `Landed ${bestImpact.prs} PR(s) / ${bestImpact.commits} commit(s) into ${bestImpact.repo} (${bestImpact.stars} stars) — ecosystem impact at ${p}%.`;
}

function communityLine(ctx: Ctx, lang: "zh" | "en"): string {
  const { m } = ctx;
  const p = pct(ctx.scoring.sub_scores.community_influence, "community_influence");
  if (lang === "zh") {
    return `${m.followers} 关注者 / ${m.following} 关注中,社区影响力 ${p}%。`;
  }
  return `${m.followers} followers / following ${m.following} — community influence at ${p}%.`;
}

function activityLine(ctx: Ctx, lang: "zh" | "en"): string {
  const { m } = ctx;
  const p = pct(ctx.scoring.sub_scores.activity_authenticity, "activity_authenticity");
  const days = m.days_since_last_activity;
  if (lang === "zh") {
    const recency = days === null ? "无法判断最近活跃时间" : days <= 90 ? `最近 ${days} 天内活跃` : `已有 ${days} 天没有动静`;
    return `过去一年贡献 ${m.last_year_contributions} 次,${recency},活跃真实性 ${p}%。`;
  }
  const recency = days === null ? "recency unknown" : days <= 90 ? `active within the last ${days} days` : `quiet for ${days} days`;
  return `${m.last_year_contributions} contributions in the last year, ${recency} — activity authenticity at ${p}%.`;
}

function riskParagraph(ctx: Ctx, lang: "zh" | "en"): string {
  if (ctx.scoring.red_flags.length === 0) return "";
  const flags = ctx.scoring.red_flags.slice(0, 3).map((f) => f.detail).join(lang === "zh" ? ";" : "; ");
  return lang === "zh"
    ? `\n**风险标记**: ${flags}\n`
    : `\n**Risk Flags**: ${flags}\n`;
}

export function buildRoastReport(ctx: Ctx, lang: "zh" | "en"): string {
  const roastLine = buildRoastLine(ctx);
  const title = `## ${ctx.username} — ${ctx.scoring.final_score}/100 · ${ctx.scoring.tier}`;
  if (lang === "zh") {
    return [
      title,
      "",
      `**${DIM_LABEL_ZH.account_maturity}**: ${maturityLine(ctx, "zh")}`,
      `**${DIM_LABEL_ZH.original_project_quality}**: ${projectQualityLine(ctx, "zh")}`,
      `**${DIM_LABEL_ZH.contribution_quality}**: ${contributionLine(ctx, "zh")}`,
      `**${DIM_LABEL_ZH.ecosystem_impact}**: ${ecosystemLine(ctx, "zh")}`,
      `**${DIM_LABEL_ZH.community_influence}**: ${communityLine(ctx, "zh")}`,
      `**${DIM_LABEL_ZH.activity_authenticity}**: ${activityLine(ctx, "zh")}`,
      riskParagraph(ctx, "zh"),
      `🔥 **毒舌点评**: ${roastLine.zh}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    title,
    "",
    `**${DIM_LABEL_EN.account_maturity}**: ${maturityLine(ctx, "en")}`,
    `**${DIM_LABEL_EN.original_project_quality}**: ${projectQualityLine(ctx, "en")}`,
    `**${DIM_LABEL_EN.contribution_quality}**: ${contributionLine(ctx, "en")}`,
    `**${DIM_LABEL_EN.ecosystem_impact}**: ${ecosystemLine(ctx, "en")}`,
    `**${DIM_LABEL_EN.community_influence}**: ${communityLine(ctx, "en")}`,
    `**${DIM_LABEL_EN.activity_authenticity}**: ${activityLine(ctx, "en")}`,
    riskParagraph(ctx, "en"),
    `🔥 **Roast**: ${roastLine.en}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export { weakestDimension, dominantDimension };
