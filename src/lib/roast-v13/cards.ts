/**
 * Loose normalization for roast v13: deterministic code turns the scan payload
 * into a fixed-schema list of salient "fact cards". The writer picks and
 * phrases cards; it never mines raw metrics. Each card carries a weight, the
 * payload path it came from, and (when it has one) the verbatim source text a
 * quote may use. Trivial stats (follower ratios, time windows, a handful of PRs
 * to a famous repo when the account has real work elsewhere) never become hook
 * cards; follower and calendar counts only reach the dimension notes.
 */
import { V13_DIMENSIONS } from "./render";

export type V13Dimension = (typeof V13_DIMENSIONS)[number];

export type CardKind =
  | "project"
  | "maintenance"
  | "core_change"
  | "work_cluster"
  | "direction"
  | "review"
  | "doc_share"
  | "gap"
  | "bio"
  | "risk"
  | "external_touch"
  | "community"
  | "activity";

export type QuoteSource = "bio" | "description" | "pr_title";

export interface FactCard {
  id: string;
  kind: CardKind;
  /** 0–1, higher = more worth a reader's attention. */
  weight: number;
  /** May anchor the one-liner or a roast point. Context cards (community, activity) may not. */
  hook: boolean;
  /** Dimension notes this card can support. */
  dims: V13Dimension[];
  /** Plain-language statement of the fact, already true; the writer rephrases it. */
  claim: string;
  /** The exact values the claim rests on. */
  facts: Record<string, string | number | boolean | string[]>;
  /** Payload path, for audits. */
  source: string;
  /** Verbatim texts a quote may use, inserted by code via {{q:<id>}} (first) or {{q:<id>#<n>}}. */
  quotes?: { text: string; source: QuoteSource; repo?: string }[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const txt = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const day = (v: unknown): string => (typeof v === "string" ? v.slice(0, 10) : "");
const lg = (n: number) => Math.log10(Math.max(1, n));
const clamp01 = (n: number) => Math.max(0, Math.min(1, Math.round(n * 100) / 100));

const FAMOUS_STARS = 10_000;
const TOKEN_WORK = 15;
const MAJOR_COMMITS = 50;
const MAJOR_PRS = 20;

function langList(v: unknown): string[] {
  return (Array.isArray(v) ? v : [])
    .map((l) => (typeof l === "string" ? l : isRec(l) ? txt(l.name) : ""))
    .filter(Boolean)
    .slice(0, 4);
}

/** "613/1284 commits; leader 613" → {mine: 613, total: 1284, leader: 613} */
function parseShare(evidence: string[], unit: RegExp): { mine: number; total: number; leader?: number } | null {
  for (const e of evidence) {
    if (/last \d+ days/i.test(e)) continue; // time-window evidence is not a card
    const m = e.match(/(\d+)\s*\/\s*(\d+)\s+([a-z ]+)/i);
    if (m && unit.test(m[3])) {
      const leader = e.match(/leader\s+(\d+)/i);
      return { mine: Number(m[1]), total: Number(m[2]), leader: leader ? Number(leader[1]) : undefined };
    }
  }
  return null;
}


export type V13CoverageFlags = {
  partial: boolean;
  repoIncomplete: boolean;
  mergedIncomplete: boolean;
  commitIncomplete: boolean;
  reasons: string[];
};

/** Map scan.collection coverage / truncation_reasons to which fact families are unsafe. */
export function v13CoverageFlags(scan: unknown, payload?: unknown): V13CoverageFlags {
  const fromScan = isRec(scan) && isRec(scan.collection) ? scan.collection : null;
  const fromPayload = isRec(payload) && isRec(payload.collection) ? payload.collection : null;
  const collection = fromScan ?? fromPayload;
  const partial = collection?.coverage === "partial_public";
  const listed = Array.isArray(collection?.truncation_reasons)
    ? (collection!.truncation_reasons as unknown[]).map(String)
    : [];
  const reasons = partial ? (listed.length ? listed : ["partial_public"]) : [];
  // Any partial_public snapshot is incomplete for inventory / merged-PR /
  // commit totals — omit those card families rather than stating a truncated
  // window as complete. Specific truncation_reasons stay in `reasons` for the
  // skill coverage hint; they do not carve out exceptions while coverage is
  // still partial_public.
  return {
    partial,
    reasons,
    repoIncomplete: partial,
    mergedIncomplete: partial,
    commitIncomplete: partial,
  };
}

export function buildFactCards(payload: unknown, opts: { username?: string; scan?: unknown } = {}): FactCard[] {
  const p = isRec(payload) ? payload : {};
  const m = isRec(p.metrics) ? p.metrics : {};
  const user = (opts.username ?? txt(m.username)).toLowerCase();
  const cards: Omit<FactCard, "id">[] = [];
  // #594 incremental / quick scans can surface as partial_public while deepen
  // runs. Never mint inventory or merged-PR facts from an incomplete snapshot;
  // omit those cards rather than stating a truncated inventory as complete.
  const { repoIncomplete, mergedIncomplete, commitIncomplete } = v13CoverageFlags(opts.scan, p);

  const impact = arr(p.impact_repos).map((r) => ({
    repo: txt(r.repo),
    stars: num(r.stars),
    commits: num(r.commits),
    prs: num(r.prs),
  }));
  const work = new Map(impact.map((r) => [r.repo.toLowerCase(), r]));
  const hasMajorWork = impact.some((r) => r.commits >= MAJOR_COMMITS || r.prs >= MAJOR_PRS);
  const covered = new Set<string>();

  // Projects they own or are attributed with, and what each one does.
  if (!repoIncomplete) for (const r of arr(p.top_repos).slice(0, 10)) {
    const repo = txt(r.name_with_owner) || txt(r.name);
    if (!repo) continue;
    const owner = txt(r.owner_login).toLowerCase() || repo.split("/")[0].toLowerCase();
    const evidence = (Array.isArray(r.attribution_evidence) ? r.attribution_evidence : []).map(String);
    const own = owner === user;
    const attributed = r.attributed_original === true;
    if (!own && !attributed) continue;
    // The username/username profile README repo is not a project.
    if (repo.toLowerCase() === `${user}/${user}`) continue;
    const stars = num(r.stars);
    const description = txt(r.description);
    const stack = langList(r.languages);
    const language = txt(r.language);
    const topics = (Array.isArray(r.topics) ? r.topics : []).map(String).slice(0, 6);
    const pushed = day(r.pushed_at);
    const commits = parseShare(evidence, /commit/i);
    const prs = parseShare(evidence, /merged prs?/i);
    const w = work.get(repo.toLowerCase());
    const role = evidence.find((e) => /author association/i.test(e))?.replace(/author association\s*/i, "") ?? "";
    const maintainerDoc = evidence.some((e) => /maintainer|codeowner/i.test(e));
    const facts: FactCard["facts"] = { repo, stars, owned: own };
    if (language) facts.language = language;
    if (stack.length) facts.stack = stack;
    if (topics.length) facts.topics = topics;
    if (pushed) facts.last_push = pushed;
    if (commits) Object.assign(facts, { your_commits: commits.mine, repo_commits: commits.total, top_committer_commits: commits.leader ?? commits.mine });
    else if (w) facts.your_commits = w.commits;
    if (prs) Object.assign(facts, { your_merged_prs: prs.mine, repo_merged_prs: prs.total });
    else if (w?.prs) facts.your_merged_prs = w.prs;
    if (role) facts.role = role;
    if (maintainerDoc) facts.listed_as_maintainer = true;
    const parts = [`${repo}(${stars} 星${language ? `,${language}` : stack.length ? `,${stack[0]}` : ",未检出语言"})`];
    parts.push(description ? "它是做什么的见 quotes(仓库描述原文)" : "仓库没有描述");
    // Absolute counts + role only — never "N 里 M 个是 TA 的" share contrasts.
    if (commits) {
      parts.push(`TA 在这里有 ${commits.mine} 个提交`);
      // Qualitative depth only — never "提交数第一 / 不是提交数第一" rank talk
      // (rank contrasts leak into roast copy). Maintainer/role comes from facts.role.
      if (commits.leader !== undefined && commits.leader === commits.mine) parts.push("是这边主笔量级的提交");
      else if (commits.leader !== undefined && commits.leader > commits.mine) parts.push("是客座量级的提交");
    } else if (w?.commits) {
      parts.push(`TA 在这里有 ${w.commits} 个提交`);
    }
    if (prs) parts.push(`TA 在这里合过 ${prs.mine} 个已合并 PR`);
    if (pushed) parts.push(`最后推送 ${pushed}`);
    const share = commits ? commits.mine / Math.max(1, commits.total) : 0;
    covered.add(repo.toLowerCase());
    const famousToken = !own && stars >= FAMOUS_STARS && hasMajorWork && (commits?.mine ?? 0) + (prs?.mine ?? 0) <= TOKEN_WORK;
    if (famousToken) continue;
    cards.push({
      kind: own ? "project" : "maintenance",
      weight: own
        ? clamp01(0.3 + 0.07 * lg(stars + 1) + 0.05 * lg((w?.commits ?? 0) + 1))
        : clamp01(0.25 + 0.1 * lg((commits?.mine ?? 0) + (prs?.mine ?? 0) + 1) + 0.3 * share + 0.03 * lg(stars + 1) + (maintainerDoc ? 0.1 : 0)),
      hook: true,
      dims: ["original_project_quality", "contribution_quality", "ecosystem_impact"],
      claim: parts.join(","),
      facts,
      source: `top_repos[${repo}]`,
      ...(description ? { quotes: [{ text: description, source: "description" as const, repo }] } : {}),
    });
    const reviewed = evidence.map((e) => e.match(/reviewed\s+(\d+)\s+PRs?/i)).find(Boolean);
    if (reviewed) {
      cards.push({
        kind: "review",
        weight: clamp01(0.25 + 0.1 * lg(Number(reviewed[1]))),
        hook: true,
        dims: ["community_influence", "contribution_quality"],
        claim: `在 ${repo} 审过别人 ${reviewed[1]} 个 PR`,
        facts: { repo, reviewed_prs: Number(reviewed[1]) },
        source: `top_repos[${repo}].attribution_evidence`,
      });
    }
  }

  // Long-term work in other repos (maintenance depth), excluding token touches.
  if (!repoIncomplete && !commitIncomplete && !mergedIncomplete) for (const r of impact) {
    const key = r.repo.toLowerCase();
    if (covered.has(key) || key === `${user}/${user}`) continue;
    const total = r.commits + r.prs;
    if (total === 0) continue;
    const token = total <= TOKEN_WORK;
    if (token && hasMajorWork) continue; // a few PRs to a famous repo is not a point
    cards.push({
      kind: token ? "external_touch" : "maintenance",
      weight: clamp01(token ? 0.15 + 0.03 * lg(r.stars) : 0.3 + 0.1 * lg(total) + 0.04 * lg(r.stars)),
      hook: true,
      dims: ["ecosystem_impact", "contribution_quality"],
      claim: `${r.repo}(${r.stars} 星)上有 TA 的 ${r.commits} 个提交、${r.prs} 个 PR`,
      facts: { repo: r.repo, stars: r.stars, commits: r.commits, prs: r.prs },
      source: `impact_repos[${r.repo}]`,
    });
  }

  // What the code changes actually were.
  if (!mergedIncomplete) for (const r of arr(p.verified_impact_prs).filter((x) => x.trivial !== true).slice(0, 8)) {
    const repo = txt(r.repo);
    const title = txt(r.title);
    if (!repo || !title) continue;
    const files = num(r.changed_files);
    const stars = num(r.repo_stars);
    cards.push({
      kind: "core_change",
      weight: clamp01(0.3 + 0.06 * lg(num(r.churn) + 1) + 0.03 * lg(stars + 1)),
      hook: true,
      dims: ["contribution_quality", "ecosystem_impact"],
      claim: `已合并到 ${repo}(${stars} 星)的 PR,标题为原文,改了 ${files} 个文件`,
      facts: { repo, repo_stars: stars, changed_files: files },
      source: `verified_impact_prs[${repo}]`,
      quotes: [{ text: title, source: "pr_title", repo }],
    });
  }

  const sig = isRec(p.signature_work) ? p.signature_work : {};
  if (!mergedIncomplete) for (const c of arr(sig.work_clusters).slice(0, 4)) {
    const repo = txt(c.repo);
    const n = num(c.recent_merged_prs_in_sample);
    const examples = (Array.isArray(c.examples) ? c.examples : []).map(String).filter(Boolean).slice(0, 3);
    if (!repo || n < 3 || !examples.length) continue;
    cards.push({
      kind: "work_cluster",
      weight: clamp01(0.3 + 0.1 * lg(n)),
      hook: true,
      dims: ["activity_authenticity", "contribution_quality"],
      claim: `近期已合并 PR 样本里有 ${n} 个集中在 ${repo}(${num(c.stars)} 星),quotes 是其中几个标题原文`,
      facts: { repo, stars: num(c.stars), recent_merged_prs_in_sample: n },
      source: `signature_work.work_clusters[${repo}]`,
      quotes: examples.map((text) => ({ text, source: "pr_title" as const, repo })),
    });
  }

  // Technical direction.
  const scan = isRec(opts.scan) ? opts.scan : {};
  const langSrc = isRec(p.estimated_contribution_languages) ? p.estimated_contribution_languages : scan.estimated_contribution_languages;
  const scanLangs = isRec(langSrc) ? arr(langSrc.languages).filter((l) => num(l.pct) >= 3) : [];
  if (!commitIncomplete && !mergedIncomplete && scanLangs.length) {
    const top = scanLangs.slice(0, 4).map((l) => `${txt(l.name)} ${num(l.pct)}%`);
    cards.push({
      kind: "direction",
      weight: 0.45,
      hook: true,
      dims: ["contribution_quality", "original_project_quality"],
      claim: `贡献语言分布:${top.join("、")}`,
      facts: Object.fromEntries(scanLangs.slice(0, 4).map((l) => [txt(l.name), num(l.pct)])),
      source: "estimated_contribution_languages",
    });
  }

  const docRatio = num(m.recent_external_doc_like_pr_ratio);
  if (!mergedIncomplete && docRatio >= 0.4) {
    cards.push({
      kind: "doc_share",
      weight: clamp01(0.3 + docRatio * 0.4),
      hook: true,
      dims: ["contribution_quality", "ecosystem_impact"],
      claim: `最近合并到外部仓库的 PR 里约 ${Math.round(docRatio * 100)}% 是文档/站点/示例/样式类`,
      facts: { external_doc_like_percent: Math.round(docRatio * 100) },
      source: "metrics.recent_external_doc_like_pr_ratio",
    });
  }

  // Gaps advice can be built on.
  if (!repoIncomplete) for (const r of arr(p.top_repos)) {
    const repo = txt(r.name_with_owner);
    if (!repo || repo.split("/")[0].toLowerCase() !== user) continue;
    const stars = num(r.stars);
    const noCode = !txt(r.language) && !langList(r.languages).length;
    if (noCode && stars >= 5 && repo.split("/")[1].toLowerCase() !== user) {
      cards.push({
        kind: "gap",
        weight: clamp01(0.3 + 0.05 * lg(stars)),
        hook: true,
        dims: ["original_project_quality"],
        claim: `${repo}(${stars} 星)没有检出任何代码语言,最后推送 ${day(r.pushed_at)}`,
        facts: { repo, stars, last_push: day(r.pushed_at), language: "none" },
        source: `top_repos[${repo}]`,
      });
    }
  }
  const rejected = num(m.maintainer_closed_unmerged_pr_count);
  if (!mergedIncomplete && rejected >= 5) {
    cards.push({
      kind: "gap",
      weight: 0.35,
      hook: true,
      dims: ["contribution_quality"],
      claim: `有 ${rejected} 个 PR 被维护者关闭且未合并(总已合并 ${num(m.merged_pr_count)} 个)`,
      facts: { maintainer_closed_unmerged: rejected, merged_prs: num(m.merged_pr_count) },
      source: "metrics.maintainer_closed_unmerged_pr_count",
    });
  }

  const bio = txt(m.bio);
  if (bio) {
    cards.push({
      kind: "bio",
      weight: 0.3,
      hook: true,
      dims: [],
      claim: "GitHub 简介原文见 quotes(只能用 token 引用,不得转述或翻译)",
      facts: { has_bio: true },
      source: "metrics.bio",
      quotes: [{ text: bio, source: "bio" }],
    });
  }

  for (const note of (Array.isArray(p.risk_notes) ? p.risk_notes : []).map(String).filter(Boolean).slice(0, 3)) {
    const social = /粉丝|关注|followers?|following/i.test(note);
    cards.push({
      kind: "risk",
      weight: social ? 0.1 : 0.4,
      hook: !social,
      dims: ["community_influence", "activity_authenticity", "contribution_quality"],
      claim: note,
      facts: {},
      source: "risk_notes",
    });
  }

  // Context only: may appear in the dimension table, never as a hook.
  cards.push({
    kind: "community",
    weight: 0.1,
    hook: false,
    dims: ["community_influence"],
    claim: `折算计入星 ${num(m.total_stars)}(按主导/共建份额与活性折算,不是名下仓库原始加总),开过 ${num(m.issues_created)} 个 issue(粉丝/关注数禁止写入锐评正文;禁止把折算星写成名下总星/名下仓库总星)`,
    facts: { total_stars: num(m.total_stars), issues_created: num(m.issues_created) },
    source: "metrics",
  });
  {
    const parts = [`账号 ${day(m.created_at)} 注册`];
    const facts: FactCard["facts"] = {
      created_at: day(m.created_at),
      last_year_contributions: num(m.last_year_contributions),
      days_since_last_activity: num(m.days_since_last_activity),
    };
    if (!repoIncomplete) {
      parts.push(`公开仓库 ${num(m.public_repos)} 个(原创 ${num(m.original_repo_count)})`);
      facts.public_repos = num(m.public_repos);
      facts.original_repos = num(m.original_repo_count);
    }
    if (!mergedIncomplete) {
      parts.push(`已合并 PR ${num(m.merged_pr_count)} 个`);
      facts.merged_prs = num(m.merged_pr_count);
    }
    parts.push(`过去一年贡献日历共 ${num(m.last_year_contributions)} 次`);
    cards.push({
      kind: "activity",
      weight: 0.1,
      hook: false,
      dims: ["account_maturity", "activity_authenticity"],
      claim: parts.join(",") + `(禁止写"距上次活动 N 天"这类考勤填充)`,
      facts,
      source: "metrics",
    });
  }

  // Hooks by weight (capped), then the bio and context cards, which always ship.
  const always = (c: Omit<FactCard, "id">) => !c.hook || c.kind === "bio";
  const hooks = cards.filter((c) => !always(c)).sort((a, b) => b.weight - a.weight).slice(0, 22);
  return [...hooks, ...cards.filter(always)].map((c, i) => ({ ...c, id: `c${i + 1}` }));
}

/** Compact JSON the writer sees: one line per card. */
export function cardsForPrompt(cards: FactCard[]): Rec[] {
  return cards.map((c) => ({
    id: c.id,
    kind: c.kind,
    weight: c.weight,
    hook: c.hook,
    dims: c.dims,
    claim: c.claim,
    facts: c.facts,
    ...(c.quotes?.length
      ? { quotes: c.quotes.map((q, i) => ({ token: i === 0 ? `{{q:${c.id}}}` : `{{q:${c.id}#${i + 1}}}`, source: q.source, repo: q.repo, text: q.text })) }
      : {}),
  }));
}

export const ALL_DIMENSIONS = V13_DIMENSIONS;
