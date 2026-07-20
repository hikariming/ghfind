import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { TIER_LABEL_EN } from "@/lib/badge";
import { anonymousSessionPrincipal } from "@/lib/anonymous-session";
import { machineAuth } from "@/lib/machine-auth";
import {
  getArchivedRoast,
  getCanonicalScoreWriteIdentity,
  getCurrentCanonicalQuickScan,
  getLegacyReadFallbackRoast,
  getScoreScannedAt,
  updateRoast,
  type ScoreWriteIdentity,
} from "@/lib/db";
import { getRankCached } from "@/lib/rank";
import { ROAST_FRESH_MS } from "@/lib/freshness";
import { Lang, normLang } from "@/lib/lang";
import {
  ChatAttemptEvent,
  LlmConfig,
  LlmQuotaError,
  LlmTimeoutError,
  chatStreamEventsWithFallback,
  defaultLlmConfig,
  fallbackLlmConfig,
} from "@/lib/llm";
import { beatPercent } from "@/lib/percentile";
import { buildRoastMessages } from "@/lib/prompt";
import { reportMatchesLang } from "@/lib/report";
import { sanitizeIdentityClaims } from "@/lib/identity";
import {
  acquireRoastLock,
  checkRoastRequestRateLimit,
  checkRoastRateLimit,
  checkRoastNetworkRateLimit,
  checkRoastRequestNetworkRateLimit,
  clearCachedRoast,
  getCachedRoast,
  getCachedScan,
  releaseRoastLock,
  rateLimitHeaders,
  setCachedRoast,
  waitForCachedRoast,
} from "@/lib/redis";
import { tierFor } from "@/lib/score";
import type { RoastLine, RoastMeta, ScanResult, Tags, Tier } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One LLM call writes the streamed report. Scores are deterministic API data, so
// the model never gets to adjust them. The ceiling remains generous for provider
// failover, while the inner deadline keeps failures inside the in-band protocol
// instead of letting the platform 504.
// The ceiling is 240s (well under Vercel's 300s max) so a stalled primary can
// fail over to DeepSeek and STILL have a fresh budget to finish — the old 120s
// cap physically couldn't fit primary + fallback, so the fallback got ~0s and
// timed out. Fluid Compute bills active CPU,
// not the idle wait on the model, so the higher ceiling costs ~nothing. The LLM
// work is bounded a touch under this (`llmDeadlineMs`) so we fail gracefully here
// (roast_failed) instead of the platform 504'ing. Keep the inner budget below it.
export const maxDuration = 240;

/** Response header carrying the score meta (base64'd JSON; it contains CJK). */
export const ROAST_META_HEADER = "X-Roast-Meta";

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const EMPTY_ROAST_LINE: RoastLine = { zh: "", en: "" };

interface ByoKey {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

interface RoastBody {
  scan?: ScanResult;
  /** Bare handle when the client has no scan payload (profile-page live roast).
   * The route then relies on the server-side cached scan (getCachedScan). */
  username?: string;
  byoKey?: ByoKey;
  /** UI locale → report language. Defaults to zh (see {@link normLang}). */
  lang?: string;
  /** Ask to regenerate instead of replaying the cache/archive. Honored only when
   * the server confirms the stored roast is stale (scanned_at older than
   * ROAST_FRESH_MS) — otherwise ignored, so the flag can't burn LLM credit. */
  refresh?: boolean;
}

/** Map a thrown LLM error to a coarse failure kind for the triage log. */
function classifyLlmError(e: unknown): "timeout" | "quota" | "upstream" | "other" {
  if (e instanceof LlmTimeoutError) return "timeout";
  if (e instanceof LlmQuotaError) return "quota";
  const msg = e instanceof Error ? e.message : String(e);
  if (/^LLM (error \d|request failed)/.test(msg)) return "upstream";
  return "other";
}

/** One structured line per roast (success or failure) for prod triage. Failure
 *  rows carry the stage (generation|meta|stream) and kind (timeout|quota|
 *  upstream|other) so we can tell a slow-LLM timeout from an upstream 5xx from a
 *  parse miss without reading code. Never let logging throw into the roast path. */
function logRoastSummary(fields: Record<string, unknown>): void {
  try {
    console.log("roast.summary", JSON.stringify(fields));
  } catch {
    /* ignore */
  }
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

function resolveConfig(byo?: ByoKey): { config: LlmConfig; isDefault: boolean } | null {
  if (byo?.apiKey && byo.baseURL && byo.model) {
    return { config: { baseURL: byo.baseURL, apiKey: byo.apiKey, model: byo.model }, isDefault: false };
  }
  const config = defaultLlmConfig();
  return config ? { config, isDefault: true } : null;
}

/** Parse the `@@TAGS zh=...|en=...@@` control line into clean, capped tag lists. */
function parseTags(head: string): Tags {
  const m = head.match(/@@TAGS\s*([^@]*?)@@/);
  if (!m) return { zh: [], en: [] };
  const body = m[1];
  const grab = (key: string): string[] => {
    const mm = body.match(new RegExp(`${key}=([^|@]+)`));
    if (!mm) return [];
    return mm[1].split(/[,，、]/).map((t) => t.trim());
  };
  const clean = (arr: string[], maxLen: number): string[] =>
    Array.from(
      new Set(
        arr
          .map((t) => t.replace(/[#@]/g, "").trim())
          .filter(Boolean)
          .map((t) => t.slice(0, maxLen)),
      ),
    ).slice(0, 5);
  return { zh: clean(grab("zh"), 10), en: clean(grab("en"), 24) };
}

const ROAST_LINE_MAX_CHARS = 180;

function tidyRoastLine(text: string): string {
  let out = text.trim().replace(/\s+([.!?。！？…])/gu, "$1");
  for (const [open, close] of [
    ["“", "”"],
    ["‘", "’"],
  ] as const) {
    const openCount = Array.from(out.matchAll(new RegExp(open, "gu"))).length;
    const closeCount = Array.from(out.matchAll(new RegExp(close, "gu"))).length;
    if (openCount > closeCount) out = out.replace(new RegExp(`${open}(?!.*${open})`, "u"), "");
    if (closeCount > openCount) out = out.replace(new RegExp(close, "u"), "");
  }
  if ((out.match(/"/g)?.length ?? 0) % 2 === 1) {
    out = out.replace(/"([^"]*)$/u, "$1");
  }
  return out.trim();
}

function clampRoastLine(raw: string, lang?: "zh" | "en"): string {
  const withoutControlChars = raw.replace(/[#@]/g, "");
  const languageCleaned =
    lang === "en"
      ? withoutControlChars.replace(/\p{Script=Han}+s?/gu, "maintainers")
      : withoutControlChars;
  const text = languageCleaned.replace(/\s+/g, " ").trim();
  if (Array.from(text).length <= ROAST_LINE_MAX_CHARS) return tidyRoastLine(text);

  const bodyMax = ROAST_LINE_MAX_CHARS - 1;
  let cut = Array.from(text).slice(0, bodyMax).join("").trimEnd();
  const minUsefulCut = Math.floor(ROAST_LINE_MAX_CHARS * 0.55);
  const sentenceEnd = Math.max(
    cut.lastIndexOf("."),
    cut.lastIndexOf("!"),
    cut.lastIndexOf("?"),
    cut.lastIndexOf("。"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
  );
  if (sentenceEnd >= minUsefulCut) {
    return tidyRoastLine(cut.slice(0, sentenceEnd + 1));
  }

  const wordBoundary = Math.max(
    cut.lastIndexOf(" "),
    cut.lastIndexOf(","),
    cut.lastIndexOf(";"),
    cut.lastIndexOf(":"),
    cut.lastIndexOf("，"),
    cut.lastIndexOf("；"),
    cut.lastIndexOf("："),
    cut.lastIndexOf("、"),
  );
  if (wordBoundary >= minUsefulCut) {
    cut = cut.slice(0, wordBoundary).replace(/[\s,;:，；：、-]+$/u, "").trimEnd();
  }
  return tidyRoastLine(`${cut}…`);
}

/**
 * Parse the `@@ROAST zh=...|en=...@@` control line into the bilingual one-liner.
 * Unlike {@link parseTags} this must NOT split on commas — a roast sentence
 * contains commas and CJK punctuation. `zh` runs up to the `|`; `en` to the end.
 */
function parseRoast(head: string): RoastLine {
  const m = head.match(/@@ROAST\s*([\s\S]*?)@@/);
  if (!m) return { zh: "", en: "" };
  const body = m[1];
  const grab = (key: string): string => {
    const mm = body.match(new RegExp(`${key}=([\\s\\S]*?)(?=\\||$)`));
    return clampRoastLine(mm?.[1] ?? "", key === "en" ? "en" : "zh");
  };
  return { zh: grab("zh"), en: grab("en") };
}

function isStrongCoreImpact(scan: ScanResult): boolean {
  const m = scan.metrics;
  return (
    (m.core_impact_pr_count ?? 0) >= 10 &&
    (m.impact_pr_count ?? 0) >= 50 &&
    (m.recent_external_doc_like_pr_ratio ?? m.recent_doc_like_pr_ratio ?? 0) < 0.25 &&
    (m.pr_rejection_rate ?? 0) < 0.2
  );
}

function sanitizeStrongCoreText(scan: ScanResult, text: string): string {
  if (!isStrongCoreImpact(scan) || !text) return text;
  return text
    .replace(/PR\s*刷子/giu, "模式PR工")
    .replace(/PR\s*Spammer/giu, "Pattern PR")
    .replace(/PR\s*Farmer/giu, "Pattern PR")
    .replace(/批量刷测试类\s*PR/gu, "批量提交测试类PR")
    .replace(/模板化刷/gu, "模板化提交")
    .replace(/刷测试\s*PR/gu, "批量提交同类测试PR")
    .replace(/刷测试用例/gu, "批量提交测试用例")
    .replace(/批量刷的/gu, "批量提交的")
    .replace(/批量刷向/gu, "批量投向")
    .replace(/集中刷向/gu, "集中投向")
    .replace(/集中刷([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/gu, "集中投向$1")
    .replace(/集中刷([A-Za-z0-9_.-]+)/gu, "集中投向$1")
    .replace(/给([^，。；,\s]+)刷的/gu, "给$1提交的")
    .replace(/刷\s*PR/gu, "批量提PR")
    .replace(/刷\s*KPI/giu, "做同类迁移")
    .replace(/刷存在感/gu, "借外部项目做曝光")
    .replace(/KPI\s*刷分场/giu, "同类改动集中场")
    .replace(/KPI\s*味/giu, "模式化味")
    .replace(/KPI/giu, "同类改动")
    .replace(/把个人项目的星刷上去/gu, "把个人项目做出星标")
    .replace(/刷量/gu, "模式化贡献")
    .replace(/刷/gu, "提交")
    .replace(/蹭外部项目/gu, "依赖外部项目")
    .replace(/蹭大厂|蹭大项目/gu, "依赖大项目")
    .replace(/蹭/gu, "依赖")
    .replace(/混到顶级档位/gu, "站到顶级档位")
    .replace(/含水量/gu, "争议点")
    .replace(/有水分/gu, "有争议")
    .replace(/水分/gu, "争议点")
    .replace(/含水/gu, "需复核")
    .replace(/低质量贡献/gu, "需复核贡献")
    .replace(/垃圾贡献/gu, "需复核贡献")
    .replace(/凑\s*KPI/giu, "做同类迁移")
    .replace(/凑数/gu, "需复核")
    .replace(/没混上提交权限/gu, "没有直接 commit 信号")
    .replace(/没混上写源码的权限/gu, "没有直接 commit 信号")
    .replace(/没(?:混上|拿到)[^。；，,]{0,12}(?:commit|提交|写源码)[^。；，,]{0,8}(?:权限|资格)/giu, "没有直接 commit 信号")
    .replace(/没有[^。；，,]{0,12}(?:commit|提交|写源码)[^。；，,]{0,8}(?:权限|资格)/giu, "没有直接 commit 信号")
    .replace(/没有提交权限/gu, "没有直接 commit 信号")
    .replace(/没有\s*commit\s*权限/giu, "没有直接 commit 信号")
    .replace(/没拿到\s*commit\s*权限/giu, "没有直接 commit 信号")
    .replace(/没有\s*commit\s*贡献记录/giu, "未检测到直接 commit 信号")
    .replace(/贡献深度存疑/gu, "但 PR 贡献样本足够扎实")
    .replace(/不被信任/gu, "没有直接 commit 信号")
    .replace(/AI\s*代笔/giu, "AI辅助")
    .replace(/AI\s*生成的玩具/giu, "AI辅助的小工具")
    .replace(/AI\s*生成/giu, "AI辅助")
    .replace(/ghostwriting/giu, "AI assistance")
    .replace(/ChatGPT-written/giu, "ChatGPT-assisted")
    .replace(/不嫌丢人/gu, "有原创性争议")
    .replace(/丢不有原创性争议/gu, "有原创性争议")
    .replace(/作弊|丢人|懒/gu, "有原创性争议");
}

function sanitizeInternalScoringText(text: string): string {
  return text
    .replace(/commit\s*数为\s*0[^。；\n]*(?:权限|permission)[^。；\n]*/giu, "commit 数为 0，只说明检测到的高星影响来自 PR")
    .replace(/((?:高星仓库|高星)?生态影响力?)被(?:评分引擎)?(?:硬?压(?:到(?:了)?)?|封顶到|裁定为)\s*([0-9.]+(?:\/20|分)?)/gu, "$1只有$2")
    .replace(/((?:生态影响|生态影响力|贡献质量|原创项目质量|活跃真实性|社区影响力|账号成熟度))被(?:硬?压(?:到(?:了)?)?|封顶到|裁定为)\s*分/gu, "$1偏弱")
    .replace(/((?:生态影响|生态影响力|贡献质量|原创项目质量|活跃真实性|社区影响力|账号成熟度))被(?:硬?压(?:到(?:了)?)?|封顶到|裁定为)\s*([0-9.]+(?:\/[0-9.]+|分)?)/gu, "$1只有$2")
    .replace(/被评分引擎(?:硬?压(?:到(?:了)?)?|封顶|裁定)[^，。；\n]*/gu, "这项表现偏弱")
    .replace(/被评分引擎[^，。；\n]*/gu, "这项表现偏弱")
    .replace(/被(?:硬?压(?:到(?:了)?)?|封顶到|裁定为)\s*分/gu, "偏弱")
    .replace(/被(?:硬?压(?:到(?:了)?)?|封顶到|裁定为)\s*([0-9.]+(?:\/[0-9.]+|分)?)/gu, "只有$1")
    .replace(/被评分现偏弱/gu, "表现偏弱")
    .replace(/被有\s*([0-9.]+(?:\/[0-9.]+|分)?)/gu, "只有$1")
    .replace(/评分已封顶/gu, "这项表现偏弱")
    .replace(/按规则扣分/gu, "数据上吃亏")
    .replace(/没混进核心组/gu, "没进入太多核心改动区")
    .replace(/scoring engine (?:capped|decided)[^,.;\n]*/giu, "the evidence is weak here")
    .replace(/score cap/giu, "weak evidence")
    .replace(/rules deducted/giu, "the data hurts here");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repoEvidenceSources(scan: ScanResult): string[] {
  const repos = [
    ...(scan.impact_repos ?? []).map((repo) => repo.repo),
    ...(scan.signature_work?.impact_repo_representatives ?? []).map((repo) => repo.repo),
    ...(scan.signature_work?.work_clusters ?? []).map((cluster) => cluster.repo),
  ];
  return [...new Set(repos.filter((repo) => /^[^/\s]+\/[^/\s]+$/u.test(repo)))];
}

function sanitizeRepoShorthandText(scan: ScanResult, text: string): string {
  if (!text) return text;
  const aliases = new Map<string, string | null>();
  for (const full of repoEvidenceSources(scan)) {
    const alias = full.split("/").pop();
    if (!alias || alias.length < 3) continue;
    const key = alias.toLowerCase();
    const existing = aliases.get(key);
    aliases.set(key, existing && existing !== full ? null : full);
  }

  let out = text;
  for (const [alias, full] of aliases) {
    if (!full) continue;
    const escaped = escapeRegExp(alias);
    const starPrefix =
      String.raw`((?:[★☆]\s*)?(?:\d+(?:\.\d+)?|[\d,]+)(?:\s*(?:k|K|万))?\s*(?:star|stars|星)(?:的)?\s*)`;
    out = out.replace(
      new RegExp(`${starPrefix}${escaped}(?![A-Za-z0-9_/-])`, "giu"),
      (_match, prefix: string) => `${prefix}${full}`,
    );
    out = out.replace(
      new RegExp(`(向\\s*)${escaped}(?=[\\s、，。；,.!?)）]*(?:贡献|提交|投|塞|发|提))`, "giu"),
      (_match, prefix: string) => `${prefix}${full}`,
    );
  }
  return out;
}

function sanitizeOutputText(scan: ScanResult, text: string): string {
  return sanitizeStrongCoreText(
    scan,
    sanitizeRepoShorthandText(scan, sanitizeInternalScoringText(text)),
  );
}

function signatureWorkAppendix(scan: ScanResult, lang: Lang, report: string): string {
  const clusters = scan.signature_work?.work_clusters ?? [];
  if (clusters.length === 0) return "";
  const mentioned = (repo: string) => report.toLowerCase().includes(repo.toLowerCase());
  const top = clusters[0];
  const orgContext = clusters.find((cluster) => cluster.org_context_repo);
  const candidateMap = new Map<string, (typeof clusters)[number]>();
  if (top) candidateMap.set(top.repo, top);
  if (orgContext) candidateMap.set(orgContext.repo, orgContext);
  const candidates = [...candidateMap.values()];
  const missing = candidates.filter((cluster) => !mentioned(cluster.repo)).slice(0, 2);
  if (missing.length === 0) return "";

  const source =
    scan.signature_work?.source === "all_history_public_scan"
      ? lang === "en"
        ? "all-history scan"
        : "全量历史"
      : lang === "en"
        ? "recent sample"
        : "近期样本";
  const lines = missing.map((cluster, index) => {
    const count = cluster.all_time_prs ?? cluster.recent_merged_prs_in_sample ?? 0;
    const examples = cluster.examples.slice(0, 2).filter(Boolean).join("；");
    if (lang === "en") {
      if (cluster.org_context_repo) {
        return `- ${cluster.repo}: ${count} PRs in the same owner ecosystem as ${cluster.org_context_repo}; low stars are not enough to dismiss it${examples ? `, with examples like "${examples}"` : ""}.`;
      }
      if (cluster.substantive_low_star_signal) {
        return `- ${cluster.repo}: a low-star but core-looking ${source} work cluster with ${count} PRs${examples ? `, including "${examples}"` : ""}.`;
      }
      return index === 0
        ? `- Additional auditable activity includes ${cluster.repo}: ${count} PRs${examples ? `, for example "${examples}"` : ""}; docs/site/example work is maintenance evidence, not proof of core fixes.`
        : `- Another auditable thread is ${cluster.repo}: ${count} PRs in the ${source}${examples ? `, e.g. "${examples}"` : ""}; docs/site/example work should be read as maintenance evidence, not core fixes.`;
    }
    if (cluster.org_context_repo) {
      return `- ${cluster.repo}: ${count} 个 PR 不是孤立小仓库劳动；它和 ${cluster.org_context_repo} 同属 owner 生态，不能只按 star 当边角料${examples ? `，代表标题如「${examples}」` : ""}。`;
    }
    if (cluster.substantive_low_star_signal) {
      return `- ${cluster.repo}: 虽然 star 不高，但 ${source}里有 ${count} 个 PR 且标题指向核心修复或边界/一致性工作${examples ? `，例如「${examples}」` : ""}。`;
    }
    return index === 0
      ? `- 额外可核对的活动还包括 ${cluster.repo}: ${count} 个 PR${examples ? `，例如「${examples}」` : ""}；docs/site/example 类标题只能当维护或样例工作看，不能证明核心修复。`
      : `- 另一个可核对的贡献线程是 ${cluster.repo}: ${source}显示 ${count} 个 PR${examples ? `，如「${examples}」` : ""}；若是 docs/site/example 类标题，只能当维护或样例工作看。`;
  });
  return lang === "en"
    ? `\n\n**Additional evidence**\n${lines.join("\n")}`
    : `\n\n**补充证据**\n${lines.join("\n")}`;
}

function sanitizeStrongCoreRoast(
  scan: ScanResult,
  tags: Tags,
  roastLine: RoastLine,
  report: string,
): { tags: Tags; roastLine: RoastLine; report: string } {
  if (!isStrongCoreImpact(scan)) return { tags, roastLine, report };
  return {
    tags: {
      zh: Array.from(new Set(tags.zh.map((tag) => sanitizeOutputText(scan, tag)))),
      en: Array.from(new Set(tags.en.map((tag) => sanitizeOutputText(scan, tag)))),
    },
    roastLine: {
      zh: sanitizeOutputText(scan, roastLine.zh),
      en: sanitizeOutputText(scan, roastLine.en),
    },
    report: sanitizeOutputText(scan, report),
  };
}

/** Strip the leading control lines so they never reach the rendered report. */
function extractReport(head: string): string {
  const lines = head.split("\n");
  const idx = lines.findIndex((l) => /^\s*##\s/.test(l));
  if (idx >= 0) return lines.slice(idx).join("\n");
  // No heading found (model ignored format) — just drop any control lines.
  return lines.filter((l) => !/@@(ADJUST|TAGS|ROAST)/.test(l)).join("\n").replace(/^\n+/, "");
}

/** Bound a client-supplied scan so a fabricated payload can't bloat the prompt. */
function sanitizeScan(scan: ScanResult): ScanResult {
  return {
    metrics: scan.metrics,
    top_repos: (scan.top_repos ?? []).slice(0, 10).map((r) => {
      const promptSummary = r.readme?.features?.prompt_summary;
      return {
        ...r,
        description: r.description?.slice(0, 300) ?? null,
        readme_excerpt: r.readme_excerpt?.slice(0, 1500) ?? null,
        readme:
          typeof promptSummary === "string" && r.readme
            ? {
                ...r.readme,
                features: {
                  ...r.readme.features,
                  prompt_summary: promptSummary.slice(0, 1500),
                },
              }
            : undefined,
      };
    }),
    recent_prs: (scan.recent_prs ?? []).slice(0, 50).map((p) => ({
      ...p,
      title: p.title?.slice(0, 200) ?? null,
      files: (p.files ?? []).slice(0, 20).map((f) => f.slice(0, 200)),
    })),
    flood_pr_titles: (scan.flood_pr_titles ?? []).slice(0, 5).map((t) => t.slice(0, 200)),
    impact_repos: (scan.impact_repos ?? []).slice(0, 8),
    verified_impact_prs: (scan.verified_impact_prs ?? []).slice(0, 12).map((p) => ({
      ...p,
      title: p.title?.slice(0, 200) ?? null,
      files: (p.files ?? []).slice(0, 20).map((f) => f.slice(0, 200)),
    })),
    signature_work: scan.signature_work
      ? {
          source: scan.signature_work.source,
          impact_repo_representatives: (scan.signature_work.impact_repo_representatives ?? []).slice(0, 12),
          work_clusters: (scan.signature_work.work_clusters ?? []).slice(0, 16).map((cluster) => ({
            ...cluster,
            examples: cluster.examples.slice(0, 5).map((example) => example.slice(0, 200)),
          })),
        }
      : undefined,
    scoring: scan.scoring,
  };
}

function metaHeader(meta: RoastMeta): string {
  return Buffer.from(JSON.stringify(meta), "utf-8").toString("base64");
}

function roastResponse(body: ReadableStream<Uint8Array> | string, meta: RoastMeta): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      [ROAST_META_HEADER]: metaHeader(meta),
    },
  });
}

/** Deterministic (pre-LLM) meta for the streaming response's header. The header
 *  must be sent before the body, but the AI-adjusted score/tags/roast aren't
 *  known until after generation — so the header carries the script's own score
 *  (a safe fallback) and the real values arrive later as an in-band M-frame. */
function deterministicMeta(scan: ScanResult, lang: Lang): RoastMeta {
  const { tier, tier_label: zhLabel } = tierFor(scan.scoring.final_score);
  const tier_label = lang === "en" ? TIER_LABEL_EN[tier] : zhLabel;
  return {
    final_score: scan.scoring.final_score,
    tier,
    tier_label,
    delta: 0,
    percentile: null,
    tags: { zh: [], en: [] },
    roast_line: EMPTY_ROAST_LINE,
  };
}

// In-band control protocol for the streamed generate path. Frames are single
// lines prefixed with US (\x1f, never produced by the model/markdown) and end
// with \n: `T`=thinking/progress label, `M`=base64 RoastMeta (ends the control
// phase; everything after is report markdown), `E`=JSON error. The cached/replay
// fast paths send plain report bytes with no frames, which the client also handles.
const FRAME = "\x1f";
function thinkingFrame(enc: TextEncoder, text: string): Uint8Array {
  return enc.encode(FRAME + "T" + text.replace(/\s+/g, " ").trim().slice(0, 80) + "\n");
}
function metaFrame(enc: TextEncoder, meta: RoastMeta): Uint8Array {
  return enc.encode(FRAME + "M" + metaHeader(meta) + "\n");
}
function errorFrame(enc: TextEncoder, obj: unknown): Uint8Array {
  return enc.encode(FRAME + "E" + JSON.stringify(obj) + "\n");
}

function scoreSummary(
  scan: ScanResult,
  lang: Lang,
): Pick<RoastMeta, "final_score" | "tier" | "tier_label" | "delta"> {
  const finalScore = scan.scoring.final_score;
  const { tier, tier_label: zhLabel } = tierFor(finalScore);
  const tier_label = lang === "en" ? TIER_LABEL_EN[tier] : zhLabel;
  return { final_score: finalScore, tier, tier_label, delta: 0 };
}

/** Deterministic score + tier + fresh percentile. Score persistence belongs to
 * the trusted scan-completion path and is intentionally independent of LLM work. */
async function computeMeta(
  scan: ScanResult,
  _delta: number,
  tags: Tags,
  roastLine: RoastLine,
  lang: Lang,
): Promise<RoastMeta> {
  const summary = scoreSummary(scan, lang);
  const percentile = await percentileFor(summary.final_score);
  return { ...summary, percentile, tags, roast_line: roastLine };
}

async function percentileFor(score: number): Promise<RoastMeta["percentile"]> {
  const counts = await getRankCached(score);
  return counts
    ? { beat: beatPercent(counts.below, counts.total), total: counts.total, rank: counts.rank }
    : null;
}

/** Meta for a replayed (stored) roast — score/tier come from storage, not a fresh
 * scan, so percentile is the only DB read. */
async function metaForStoredRoast(
  finalScore: number,
  tier: Tier,
  tags: Tags,
  roastLine: RoastLine,
  lang: Lang,
): Promise<RoastMeta> {
  const { tier_label: zhLabel } = tierFor(finalScore);
  const tier_label = lang === "en" ? TIER_LABEL_EN[tier] : zhLabel;
  const percentile = await percentileFor(finalScore);
  return { final_score: finalScore, tier, tier_label, delta: 0, percentile, tags, roast_line: roastLine };
}

async function cacheRoastReplay(
  username: string,
  lang: Lang,
  snapshotHash: string,
  report: string,
  tags: Tags,
  roastLine: RoastLine,
  finalScore: number,
  tier: Tier,
): Promise<void> {
  await setCachedRoast(username, lang, {
    report,
    snapshot_hash: snapshotHash,
    delta: 0,
    tags,
    roast_line: roastLine,
    final_score: finalScore,
    tier,
  });
}

export async function POST(req: NextRequest) {
  // Anchor for the LLM wall-clock budget. Deliberately taken at request start,
  // NOT at stream start: a single-flight follower can spend up to 120s in
  // waitForCachedRoast before falling back to self-generation, and a budget
  // computed from stream start would let wait + generation overrun the 240s
  // function ceiling — the platform then kills the stream mid-roast.
  const reqT0 = Date.now();
  const requestId = randomUUID();
  let body: RoastBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const username = body.scan?.metrics?.username ?? body.username;
  if (!username || !USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "missing_scan" }, { status: 400 });
  }

  // Invalid machine credentials still fail closed. Interactive browser roasts
  // are protected by the request and generation rate limits below; a heuristic
  // bot classifier must not gate this primary user-facing flow.
  const auth = machineAuth(req);
  if (auth === "invalid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ip = clientIp(req);
  // CLI/MCP callers retain their IP budget. Only an interactive browser that
  // completed Turnstile can exchange its shared-NAT IP key for a signed session.
  const principal = auth === "absent" ? anonymousSessionPrincipal(req) ?? ip : ip;

  // This protects every path, including BYO: it runs before the snapshot and
  // scan-cache reads below, while the later roast limiter remains dedicated
  // to operator-paid model generation.
  const requestLimit = await checkRoastRequestRateLimit(principal);
  if (!requestLimit.success) {
    return NextResponse.json(
      { error: requestLimit.unavailable ? "rate_limit_unavailable" : "rate_limited", useByoKey: true },
      {
        status: requestLimit.unavailable ? 503 : 429,
        headers: { ...rateLimitHeaders(requestLimit), "Cache-Control": "no-store" },
      },
    );
  }
  const networkRequestLimit = await checkRoastRequestNetworkRateLimit(ip);
  if (!networkRequestLimit.success) {
    return NextResponse.json(
      {
        error: networkRequestLimit.unavailable ? "rate_limit_unavailable" : "rate_limited",
        useByoKey: true,
      },
      {
        status: networkRequestLimit.unavailable ? 503 : 429,
        headers: { ...rateLimitHeaders(networkRequestLimit), "Cache-Control": "no-store" },
      },
    );
  }

  const lang = normLang(body.lang);

  // A verified v5/v5/v3 artifact is a read-only continuity path when the quick
  // collector is unavailable. It is intentionally checked before resolving an LLM config:
  // replaying already-persisted public text must not depend on model capacity or
  // spend credit. `refresh` explicitly opts out and continues toward v9 work.
  if (body.refresh !== true && !body.scan) {
    const legacyRoast = await getLegacyReadFallbackRoast(username, lang);
    if (legacyRoast && reportMatchesLang(legacyRoast.report, lang)) {
      const meta = await metaForStoredRoast(
        legacyRoast.final_score,
        legacyRoast.tier,
        legacyRoast.tags,
        legacyRoast.roast_line,
        lang,
      );
      logRoastSummary({
        requestId,
        lang,
        path: "legacy_read_fallback",
        ok: true,
        source: "legacy_v5_v5_v3",
        requestTotalMs: Date.now() - reqT0,
      });
      return roastResponse(legacyRoast.report, meta);
    }
  }

  const resolved = resolveConfig(body.byoKey);
  if (!resolved) {
    return NextResponse.json({ error: "no_llm_configured", useByoKey: true }, { status: 400 });
  }
  const { config, isDefault } = resolved;

  // Default path fails over to the operator's fallback provider (DeepSeek) when
  // the primary drops/queues the connection before any answer text. BYO keys
  // never fail over — the user supplied a single key and pays their own way.
  const fallback = isDefault ? fallbackLlmConfig() : null;
  const llmConfigs = fallback ? [config, fallback] : [config];
  const path = isDefault ? "default" : "byo";
  // Single-flight: set once we hold the roast lock, so the stream/error paths
  // know to release it. Only the default model coalesces (BYO keys self-serve).
  let isLeader = false;
  let lockWaitMs = 0;
  let generationPath: "leader" | "follower_fallback" | "byo" = isDefault
    ? "leader"
    : "byo";
  let scoreIdentity: ScoreWriteIdentity | null = null;

  // `/api/scan` materializes the bounded quick snapshot before the client gets
  // it. Default-model reports always prefer the exact server snapshot joined to
  // the currently served v9 score. There is no background-job dependency.
  const [canonicalQuick, cachedScan] = await Promise.all([
    getCurrentCanonicalQuickScan(username),
    getCachedScan(username),
  ]);
  const scan = canonicalQuick?.scan ?? cachedScan ?? (body.scan ? sanitizeScan(body.scan) : null);
  if (!scan?.metrics || !scan.scoring) {
    return NextResponse.json({ error: "missing_scan" }, { status: 400 });
  }
  const snapshotHash =
    canonicalQuick?.snapshotHash ?? createHash("sha256").update(JSON.stringify(scan)).digest("hex");

  // Default-model protections: serve a cached roast for free, else rate-limit the
  // (credit-spending) LLM call. BYO keys skip both — it's the user's own credit.
  if (isDefault) {
    let refreshHonored = false;
    // Every replay and new report belongs to the deterministic v9 score from
    // this exact quick snapshot. A forged request body cannot produce a report
    // because it has no matching score write identity.
    try {
      scoreIdentity = await getCanonicalScoreWriteIdentity(username, snapshotHash);
    } catch {
      scoreIdentity = null;
    }
    if (!scoreIdentity) {
      return NextResponse.json(
        { error: "score_materialization_pending" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    // A validated `refresh` skips canonical replay paths only when the
    // stored report is actually stale.
    if (body.refresh === true) {
      const scannedAt = await getScoreScannedAt(username);
      refreshHonored = scannedAt == null || Date.now() - scannedAt > ROAST_FRESH_MS;
    }

    if (!refreshHonored) {
      const cachedRoast = await getCachedRoast(username, lang);
      if (
        cachedRoast?.snapshot_hash === snapshotHash &&
        reportMatchesLang(cachedRoast.report, lang)
      ) {
        const tags = cachedRoast.tags ?? { zh: [], en: [] };
        const roastLine = cachedRoast.roast_line ?? EMPTY_ROAST_LINE;
        const meta =
          cachedRoast.final_score !== undefined && cachedRoast.tier
            ? await metaForStoredRoast(
                cachedRoast.final_score,
                cachedRoast.tier,
                tags,
                roastLine,
                lang,
              )
            : await computeMeta(scan, cachedRoast.delta, tags, roastLine, lang);
        logRoastSummary({
          requestId, lang, path, ok: true, source: "redis_cache",
          requestTotalMs: Date.now() - reqT0,
        });
        return roastResponse(cachedRoast.report, meta);
      }
      if (cachedRoast) await clearCachedRoast(username, lang);

      const archivedRoast = await getArchivedRoast(username, lang);
      if (archivedRoast && reportMatchesLang(archivedRoast.report, lang)) {
        const meta = await metaForStoredRoast(
          archivedRoast.final_score,
          archivedRoast.tier,
          archivedRoast.tags,
          archivedRoast.roast_line,
          lang,
        );
        await cacheRoastReplay(
          username,
          lang,
          snapshotHash,
          archivedRoast.report,
          archivedRoast.tags,
          archivedRoast.roast_line,
          archivedRoast.final_score,
          archivedRoast.tier,
        );
        logRoastSummary({
          requestId, lang, path, ok: true, source: "archive",
          requestTotalMs: Date.now() - reqT0,
        });
        return roastResponse(archivedRoast.report, meta);
      }
    }
    const generationLimit = await checkRoastRateLimit(principal);
    if (!generationLimit.success) {
      return NextResponse.json(
        { error: generationLimit.unavailable ? "rate_limit_unavailable" : "rate_limited", useByoKey: true },
        {
          status: generationLimit.unavailable ? 503 : 429,
          headers: { ...rateLimitHeaders(generationLimit), "Cache-Control": "no-store" },
        },
      );
    }
    const networkGenerationLimit = await checkRoastNetworkRateLimit(ip);
    if (!networkGenerationLimit.success) {
      return NextResponse.json(
        {
          error: networkGenerationLimit.unavailable ? "rate_limit_unavailable" : "rate_limited",
          useByoKey: true,
        },
        {
          status: networkGenerationLimit.unavailable ? 503 : 429,
          headers: { ...rateLimitHeaders(networkGenerationLimit), "Cache-Control": "no-store" },
        },
      );
    }
    isLeader = await acquireRoastLock(username, lang);
    if (isLeader) {
      if (refreshHonored) await clearCachedRoast(username, lang);
    } else {
      const lockWaitStartedAt = Date.now();
      const shared = await waitForCachedRoast(username, lang);
      lockWaitMs = Date.now() - lockWaitStartedAt;
      if (
        shared?.snapshot_hash === snapshotHash &&
        reportMatchesLang(shared.report, lang)
      ) {
        const tags = shared.tags ?? { zh: [], en: [] };
        const roastLine = shared.roast_line ?? EMPTY_ROAST_LINE;
        const meta =
          shared.final_score !== undefined && shared.tier
            ? await metaForStoredRoast(
                shared.final_score,
                shared.tier,
                tags,
                roastLine,
                lang,
              )
            : await computeMeta(scan, shared.delta, tags, roastLine, lang);
        logRoastSummary({
          requestId, lang, path, ok: true, source: "singleflight_shared",
          lockWaitMs, requestTotalMs: Date.now() - reqT0,
        });
        return roastResponse(shared.report, meta);
      }
      generationPath = "follower_fallback";
    }
  }

  // One model stream writes the report. Progress frames keep the client alive
  // while the model prepares its controls.
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let clientGone = false;
      const push = (bytes: Uint8Array) => {
        if (clientGone) return;
        try {
          controller.enqueue(bytes);
        } catch {
          clientGone = true;
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed (client gone)
        }
      };
      // Surface "still working" without leaking the model's chain-of-thought:
      // a curated stage label plus elapsed seconds, throttled so reasoning's
      // reasoning traces don't spam the wire.
      const t0 = Date.now();
      // Overall hard wall-clock ceiling for ALL LLM work, kept ~20s under the
      // 240s function ceiling (leaving room for meta DB writes + caching + margin).
      // The default reasoning model streams chain-of-thought continuously, so the
      // per-token idle timeout never fires on a long think; this caps everything
      // combined so a slow account fails gracefully here (roast_failed) instead of
      // the platform 504'ing the whole function. Anchored to reqT0 (request
      // start), not t0: a follower that waited out the single-flight window has
      // already spent that time against the same 240s function ceiling.
      const llmDeadlineMs = reqT0 + 220_000;
      const GENERATION_ATTEMPT_MS = 95_000;
      const attempts: ChatAttemptEvent[] = [];
      let firstEventMs: number | null = null;
      let firstContentMs: number | null = null;
      let metaMs: number | null = null;
      let lastBeat = 0;
      const beat = (label: string, force = false) => {
        const now = Date.now();
        if (!force && now - lastBeat < 1500) return;
        lastBeat = now;
        const secs = Math.round((now - t0) / 1000);
        push(thinkingFrame(enc, `${label} (${secs}s)`));
      };
      const generating = lang === "en" ? "Writing roast…" : "正在撰写锐评…";
      const summaryFields = () => ({
        requestId,
        lang,
        path,
        source: "generate",
        generationPath,
        lockWaitMs,
        streamMs: Date.now() - t0,
        requestTotalMs: Date.now() - reqT0,
        firstEventMs,
        firstContentMs,
        metaMs,
        attempts,
      });
      const failAndClose = async (obj: unknown, fields: Record<string, unknown>) => {
        // Release the single-flight lock so waiting requests aren't stalled for
        // the full lock TTL by a generation that died early.
        if (isLeader) await releaseRoastLock(username, lang);
        logRoastSummary({ ...summaryFields(), ok: false, ...fields });
        push(errorFrame(enc, obj));
        close();
      };

      beat(generating, true);
      const events = chatStreamEventsWithFallback(llmConfigs, buildRoastMessages(scan, lang), {
        deadlineMs: llmDeadlineMs,
        attemptBudgetMs: GENERATION_ATTEMPT_MS,
        temperature: 0.55,
        onAttempt(event) {
          attempts.push(event);
          if (event.phase === "first_event" && firstEventMs === null) {
            firstEventMs = Date.now() - reqT0;
          }
          if (event.phase === "first_content" && firstContentMs === null) {
            firstContentMs = Date.now() - reqT0;
          }
        },
      });
      let head = "";
      try {
        while (!/(^|\n)\s*##\s/.test(head) && head.length < 2000) {
          const { done, value } = await events.next();
          if (done) break;
          if (value.type === "content") head += value.text;
          else beat(generating);
        }
      } catch (e) {
        if (e instanceof LlmQuotaError) {
          return failAndClose(
            { error: "llm_quota", useByoKey: true, status: e.status },
            { stage: "generation", kind: "quota" },
          );
        }
        return failAndClose(
          { error: "roast_failed" },
          { stage: "generation", kind: classifyLlmError(e) },
        );
      }

      const delta = 0;
      const parsedTags = parseTags(head);
      const parsedRoastLine = parseRoast(head);
      const parsedReport = extractReport(head);
      const identitySafe = sanitizeIdentityClaims(
        scan,
        parsedTags,
        parsedRoastLine,
        parsedReport,
      );
      const { tags, roastLine, report } = sanitizeStrongCoreRoast(
        scan,
        identitySafe.tags,
        identitySafe.roastLine,
        identitySafe.report,
      );

      let meta: RoastMeta;
      try {
        meta = await computeMeta(scan, delta, tags, roastLine, lang);
        metaMs = Date.now() - reqT0;
      } catch (e) {
        return failAndClose(
          { error: "roast_failed" },
          { stage: "meta", kind: classifyLlmError(e) },
        );
      }

      // End of control phase: ship deterministic meta, then the report body.
      push(metaFrame(enc, meta));

      let full = "";
      let rawFull = "";
      let emittedCleanLength = 0;
      let pendingText = report;
      const flushPendingText = (force = false) => {
        if (!pendingText) return;
        const keep = force ? 0 : 600;
        if (!force && pendingText.length <= keep) return;
        const raw = force ? pendingText : pendingText.slice(0, -keep);
        rawFull += raw;
        pendingText = force ? "" : pendingText.slice(-keep);
        const cleanFull = sanitizeOutputText(scan, rawFull);
        const text = cleanFull.slice(emittedCleanLength);
        if (!text) return;
        full += text;
        emittedCleanLength = cleanFull.length;
        push(enc.encode(text));
      };
      try {
        flushPendingText();
        // Drain the rest of the generation (resumes where head-reading left off).
        for await (const ev of events) {
          if (ev.type !== "content") continue;
          pendingText += ev.text;
          flushPendingText();
        }
        flushPendingText(true);
        const appendix = signatureWorkAppendix(scan, lang, full);
        if (appendix) {
          full += appendix;
          push(enc.encode(appendix));
        }
        // Persist under the exact score-write identity before warming replay.
        // A late report that loses the CAS must not enter either storage layer.
        if (isDefault && reportMatchesLang(full, lang)) {
          const persisted = scoreIdentity
            ? await updateRoast(username, full, lang, scoreIdentity, { tags, roastLine })
            : false;
          if (persisted) {
            await cacheRoastReplay(
              username,
              lang,
              snapshotHash,
              full,
              tags,
              roastLine,
              meta.final_score,
              meta.tier,
            );
          }
        }
        logRoastSummary({
          ...summaryFields(), ok: true,
          score: meta.final_score, delta, chars: full.length,
        });
      } catch (e) {
        logRoastSummary({
          ...summaryFields(), ok: false, stage: "stream",
          kind: classifyLlmError(e), chars: full.length,
        });
        push(errorFrame(enc, { error: "roast_failed" }));
      } finally {
        if (isLeader) await releaseRoastLock(username, lang);
        close();
      }
    },
  });

  return roastResponse(stream, deterministicMeta(scan, lang));
}
