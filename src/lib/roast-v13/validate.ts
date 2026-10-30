/**
 * Deterministic checks for roast v13 copy: every number, repository and
 * per-repository star count the model writes is looked up in the payload the
 * model was given. The editor step receives these issues; the final pass drops
 * sentences that still cite facts absent from the data.
 */
import type { FactCard } from "./cards";
import { isTriviaTag } from "../roast-tags";
import { slotRange, SLOTS, type SlotName } from "./skill";
import {
  V13_CLICHE_PHRASES,
  V13_CLICHE_PHRASES_EN,
  V13_SNARK_BANNED_EN,
  V13_SNARK_BANNED_ZH,
} from "./voice";

export interface V13Copy {
  title: string;
  roast_line: { zh: string; en: string };
  tags: { zh: string[]; en: string[] };
  verdict: string;
  findings: { headline: string; text: string }[];
  dimensions: Record<string, string>;
  risk: string;
  advice: string[];
  /** Fact-card ids each slot cites, keyed by field label (roast_line, verdict, findings[0], dimensions.x, advice[0]). */
  cites?: Record<string, string[]>;
}

export interface V13Issue {
  kind:
    | "number" | "repo" | "repo_stars" | "cliche" | "snark" | "schema" | "language"
    | "quote" | "repeat" | "trivia" | "length" | "cite";
  field: string;
  detail: string;
}

export interface FactIndex {
  numbers: number[];
  repos: Map<string, number | null>;
  haystack: string;
  /** Normalized source texts a quote may come from (see checkQuotes). */
  sources: { bio: string; descriptions: string; all: string };
  /** Lifetime PRs + commits per repository, from impact_repos. */
  work: Map<string, number>;
  /** The account has substantial work somewhere (≥50 commits or ≥20 PRs in one repo). */
  hasMajorWork: boolean;
  followers: number;
}

const REPO_RE = /(?<![\w.-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})(?![\w-])/g;
const NUM_RE = /(?<![\w./-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|K|万)?(?![\w/])/g;

function collectNumbers(value: unknown, out: number[]): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push(value);
    return;
  }
  if (typeof value === "string") {
    for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
}

function collectRepos(value: unknown, out: Map<string, number | null>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRepos(item, out);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const name =
      (typeof obj.name_with_owner === "string" && obj.name_with_owner) ||
      (typeof obj.full_name === "string" && obj.full_name) ||
      (typeof obj.repo === "string" && obj.repo.includes("/") && obj.repo) ||
      null;
    const stars = typeof obj.stars === "number" ? Math.round(obj.stars) : null;
    if (name) {
      const key = name.toLowerCase();
      if (!out.has(key) || (out.get(key) === null && stars !== null)) out.set(key, stars);
    }
    for (const v of Object.values(obj)) collectRepos(v, out);
    return;
  }
  if (typeof value === "string") {
    for (const m of value.matchAll(REPO_RE)) {
      const key = `${m[1]}/${m[2]}`.toLowerCase();
      if (!out.has(key)) out.set(key, null);
    }
  }
}

/** Lowercase, NFKC, no whitespace/punctuation: the form quotes are compared in. */
export function normQuote(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function collectStrings(value: unknown, out: string[], skip: Set<string> = new Set()): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, skip);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!skip.has(k)) collectStrings(v, out, skip);
  }
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const asArr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(asRec) : []);

/** Build the lookup index from the exact payload object sent to the models.
 * `source` (the raw scan, when available) is what quotes are checked against;
 * it defaults to the payload. */
export function buildFactIndex(payload: unknown, source?: unknown): FactIndex {
  const raw: number[] = [];
  collectNumbers(payload, raw);
  const set = new Set<number>();
  const ints: number[] = [];
  for (const n of raw) {
    set.add(n);
    set.add(Math.round(n));
    set.add(Math.round(n * 10) / 10);
    set.add(Math.round(n * 100) / 100);
    set.add(Math.floor(n));
    if (n > 0 && n <= 1) {
      set.add(Math.round(n * 100));
      set.add(Math.round(n * 1000) / 10);
      set.add(Math.floor(n * 100));
    }
    if (Number.isInteger(n) && n > 0 && n < 1e7) ints.push(n);
  }
  // Derived shares/differences between two payload integers ("1181 of 1191",
  // "87%"), bounded so huge payloads stay cheap.
  const uniq = [...new Set(ints)].slice(0, 400);
  for (const a of uniq) {
    for (const b of uniq) {
      if (a < b) {
        set.add(Math.round((a / b) * 100));
        set.add(Math.round((a / b) * 1000) / 10);
        set.add(b - a);
      } else if (a > b && a / b < 1000) {
        const ratio = a / b;
        set.add(Math.round(ratio));
        set.add(Math.round(ratio * 10) / 10);
      }
    }
  }
  const repos = new Map<string, number | null>();
  collectRepos(payload, repos);
  const src = asRec(source ?? payload);
  const p = asRec(payload);
  const metrics = { ...asRec(p.metrics), ...asRec(src.metrics) };
  const descTexts: string[] = [];
  for (const r of [...asArr(src.top_repos), ...asArr(src.pinned_repos), ...asArr(p.top_repos)]) {
    collectStrings([r.description, r.readme_excerpt, asRec(r.readme).excerpt, asRec(r.readme).text, r.topics], descTexts);
  }
  // Model-facing instructions (contracts, guardrails, notes) are not quotable data.
  const all: string[] = [];
  collectStrings(src, all, new Set(["score_contract", "context_notes", "factual_guardrails", "sha", "html_url", "path"]));
  const work = new Map<string, number>();
  let hasMajorWork = false;
  for (const r of asArr(p.impact_repos)) {
    if (typeof r.repo !== "string") continue;
    const prs = Number(r.prs) || 0;
    const commits = Number(r.commits) || 0;
    work.set(r.repo.toLowerCase(), prs + commits);
    if (commits >= 50 || prs >= 20) hasMajorWork = true;
  }
  return {
    numbers: [...set],
    repos,
    haystack: JSON.stringify(payload).toLowerCase(),
    sources: {
      bio: normQuote(typeof metrics.bio === "string" ? metrics.bio : ""),
      descriptions: normQuote(descTexts.join("\n")),
      all: normQuote(all.join("\n")),
    },
    work,
    hasMajorWork,
    followers: Number(metrics.followers) || 0,
  };
}

function numberKnown(index: FactIndex, n: number): boolean {
  if (n <= 3) return true;
  if (n >= 1990 && n <= 2035) return true; // years are checked loosely
  return index.numbers.some((v) => Math.abs(v - n) <= Math.max(1e-9, Math.abs(n) * 0.005));
}

function numberApprox(index: FactIndex, n: number): boolean {
  return index.numbers.some((v) => Math.abs(v - n) <= Math.abs(n) * 0.05);
}

/** Every user-visible text field, flattened with a stable field label. */
export function copyFields(copy: V13Copy): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [
    { field: "title", text: copy.title },
    { field: "roast_line.zh", text: copy.roast_line.zh },
    { field: "roast_line.en", text: copy.roast_line.en },
    { field: "verdict", text: copy.verdict },
    { field: "risk", text: copy.risk },
  ];
  copy.tags.zh.forEach((t, i) => out.push({ field: `tags.zh[${i}]`, text: t }));
  copy.tags.en.forEach((t, i) => out.push({ field: `tags.en[${i}]`, text: t }));
  copy.findings.forEach((f, i) => {
    out.push({ field: `findings[${i}].headline`, text: f.headline });
    out.push({ field: `findings[${i}].text`, text: f.text });
  });
  for (const [k, v] of Object.entries(copy.dimensions)) out.push({ field: `dimensions.${k}`, text: v });
  copy.advice.forEach((a, i) => out.push({ field: `advice[${i}]`, text: a }));
  return out.filter((f) => f.text);
}

/** Check one text against the payload index. */
export function checkText(index: FactIndex, field: string, text: string): V13Issue[] {
  const issues: V13Issue[] = [];
  const repoSpans: [number, number][] = [];
  for (const m of text.matchAll(REPO_RE)) {
    const name = `${m[1]}/${m[2]}`.replace(/[.,;:]+$/, "");
    const key = name.toLowerCase();
    repoSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    // Ratios like "44/55" are numbers, not repositories.
    if (/^\d+\/\d+$/.test(name)) continue;
    if (!index.repos.has(key) && !index.haystack.includes(key)) {
      issues.push({ kind: "repo", field, detail: `repository ${name} is not in the data` });
      continue;
    }
    const stars = index.repos.get(key);
    if (stars !== null && stars !== undefined) {
      const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 14);
      const before = text.slice(Math.max(0, (m.index ?? 0) - 10), m.index ?? 0);
      const near =
        after.match(/^[`)\s(（,，的]*(?:★\s*)?(\d[\d,.]*)\s*(k|K)?\s*(?:★|星|stars?)/) ??
        before.match(/(\d[\d,.]*)\s*(k|K)?\s*(?:★|星|stars?)\s*(?:的)?\s*[`(（]*$/);
      if (near) {
        let n = Number(near[1].replace(/,/g, ""));
        if (near[2]) n *= 1000;
        const tolerance = near[2] ? Math.max(1, stars * 0.06) : Math.max(1, stars * 0.01);
        if (Math.abs(n - stars) > tolerance) {
          issues.push({ kind: "repo_stars", field, detail: `${name} has ${stars} stars, text says ${near[0].trim()}` });
        }
      }
    }
  }
  const masked = repoSpans.reduceRight(
    (acc, [s, e]) => acc.slice(0, s) + " ".repeat(e - s) + acc.slice(e),
    text,
  );
  for (const m of masked.matchAll(NUM_RE)) {
    let n = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
    if (m[3] === "k" || m[3] === "K") n *= 1000;
    if (m[3] === "万") n *= 10000;
    const ok = m[3] ? numberApprox(index, n) : numberKnown(index, n);
    if (!ok) issues.push({ kind: "number", field, detail: `number ${m[0].trim()} is not in the data` });
  }
  issues.push(...checkQuotes(index, field, text));
  return issues;
}

const QUOTE_RE = /[「『“"‘]([^「」『』“”"‘’]{1,200})[」』”"’]/g;
const DESC_WORD = /(项目简介|仓库简介|项目描述|仓库描述|描述|readme|自述|tagline|description|slogan|口号|标语)/i;
const BIO_WORD = /(简介|签名|自我介绍|个人介绍|个人说明|\bbio\b|profile)/i;
const CLAIM_RE =
  /(简介|签名|自我介绍|个人介绍|\bbio\b|描述|readme|自述|tagline|description|slogan|口号|标语)[^。！？!?；;]{0,8}?(写着|写的|写了|写|喊着|喊|说着|说|称|自称|挂着|挂|是|标着|立着|says|reads|claims|promises|calls|wants)/i;

/**
 * Quotes of the bio, a README, a repository description or a PR title must be
 * verbatim (after normalizing whitespace/punctuation/case) in the named source:
 * a sentence that names the bio must quote the bio, one that names a
 * description/README must quote a description/README, and any other quoted
 * span must exist somewhere in the scan data. A sentence that claims what the
 * bio/README/description "says" without quoting it is also an issue: those are
 * the paraphrases that turn into fabrications.
 */
export function checkQuotes(index: FactIndex, field: string, text: string): V13Issue[] {
  const issues: V13Issue[] = [];
  const matches = [...text.matchAll(QUOTE_RE)];
  const quotes = matches.map((m) => m[1]);
  const sentenceSource = DESC_WORD.test(text) ? "descriptions" : BIO_WORD.test(text) ? "bio" : "all";
  for (const m of matches) {
    const q = m[1];
    const n = normQuote(q);
    if (n.length < 2) continue;
    // The source a quote is attributed to is whatever is named just before it.
    const ctx = text.slice(Math.max(0, (m.index ?? 0) - 16), m.index ?? 0);
    const source = /(PR|标题|title)/i.test(ctx)
      ? "all"
      : DESC_WORD.test(ctx)
        ? "descriptions"
        : BIO_WORD.test(ctx)
          ? "bio"
          : matches.length === 1
            ? sentenceSource
            : "all";
    const pool = source === "bio" ? index.sources.bio : source === "descriptions" ? index.sources.descriptions : index.sources.all;
    if (!pool.includes(n)) {
      issues.push({ kind: "quote", field, detail: `quoted "${q}" is not verbatim in the ${source === "all" ? "scan data" : source}` });
    }
  }
  const source = sentenceSource;
  if (!quotes.length && CLAIM_RE.test(text)) {
    const bioEmpty = !index.sources.bio;
    const saysEmpty = /(空|没写|没有|未填|empty|blank)/i.test(text);
    if (!(source === "bio" && bioEmpty && saysEmpty)) {
      issues.push({ kind: "quote", field, detail: `claims what the ${source === "bio" ? "bio" : "README/description"} says without a verbatim quote` });
    }
  }
  return issues;
}

/** Wording bigrams: repository names and numbers are stripped, so restating a
 * fact in the table is fine and only reused phrasing counts. */
const wording = (text: string): string => normQuote(text.replace(REPO_RE, " ").replace(/\d+/g, " "));

function bigrams(text: string): Set<string> {
  const n = wording(text);
  const out = new Set<string>();
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
  return out;
}

/** Share of `a`'s character bigrams that also occur in `b` (0 when `a` is tiny). */
export function coverage(a: string, b: string): number {
  const A = bigrams(a);
  if (A.size < 6) return 0;
  const B = bigrams(b);
  let k = 0;
  for (const g of A) if (B.has(g)) k++;
  return k / A.size;
}

const SENTENCE_RE = /[^。！？!?；;]+[。！？!?；;]?/g;
const sentences = (text: string): string[] => text.match(SENTENCE_RE) ?? [text];

/** A field restates the one-liner when it covers half of it, or one of its
 * sentences (≥12 chars) is mostly the one-liner. */
export function repeatsRoastLine(roastLine: string, text: string): boolean {
  if (!roastLine || !text) return false;
  if (coverage(roastLine, text) >= 0.5) return true;
  return sentences(text).some((s) => wording(s).length >= 12 && coverage(s, roastLine) >= 0.7);
}

const FOLLOW_RE = /(粉丝|关注|followers?|following)/i;
/** Explicit follower/following counts ("粉丝 44", "followers: 12"). */
const FOLLOWER_COUNT_RE =
  /粉丝\s*\d+|关注\s*\d+|followers?\s*[:=]?\s*\d+|following\s*[:=]?\s*\d+/i;
const WINDOW_RE = /(近|最近|过去)\s*\d+\s*(天|日|周)|last\s+\d+\s+days/i;
/** "距上次活动 N 天" attendance filler. */
const DAYS_SINCE_RE =
  /距(?:上次|最近)(?:活动|提交|更新)\s*\d+\s*天|gap of\s*\d+\s*days? since|days? since last (?:activity|commit)/i;
/** Vague depth jab with no project named ("卡在厚度"). */
const THICKNESS_RE = /卡在厚度|没有厚度|厚度不够|差在厚度|缺厚度|少了厚度/;
/**
 * Any share-count contrast phrasing — banned in EVERY field including dimensions.
 * Catches: "N 个…里 (你|她|他)?(只有)? M 个", "M 个是你的", "第一名 N 个",
 * "X of Y commits/PRs", "星的 X 里你只有 M 个提交". Absolute counts alone OK.
 */
const SHARE_CONTRAST_RE =
  /\d+\s*个(?:已合并\s*)?(?:PR|pr|提交|commit)[^。！？!?；;\n]{0,28}里\s*(?:你|TA|他|她|其)?\s*(?:只有\s*)?\d+\s*个(?!\s*在)|\d+\s*个(?:已合并\s*)?(?:PR|pr|提交)?(?:是你的|是\s*TA\s*的|是他的|是她的)|(?:第一名|提交最多者|最多的人)\s*\d+\s*个|\d+\s*星的[^。！？!?；;\n]{0,40}里\s*(?:你|TA|他|她)?\s*(?:只有\s*)?\d+\s*个(?:提交|PR|pr)|\d+\s+(?:of|\/)\s*\d+\s+(?:merged\s+)?(?:PRs?|commits?)/i;
/** Advice that chases commit share / stars / followers instead of the work. */
const GAMEY_ADVICE_RE =
  /坐上主提交|协作者份额|做成主提交|多拿(?:点)?(?:提交|commit)|冲(?:提交|commit)份额|涨粉|互关|多攒(?:点)?星|追星数|get more (?:commits?|stars?|followers?)/i;
/** Treating metrics.total_stars (credited/折算) as owned-repo star sum. */
const CREDITED_AS_OWNED_STARS_RE =
  /名下(?:仓库)?总星|个人自攒(?:的)?星|自己攒(?:的)?(?:总)?星|owned(?:-repo)? total stars/i;
/** Inventing why maintainers closed PRs (scan has counts, not reasons). */
const INVENTED_CLOSE_REASON_RE =
  /(?:被?(?:维护者)?关闭|未合并|拒收|弹回)[^。！？!?\n]{0,40}(?:因为|由于|说明|都是|多是|全是)[^。！？!?\n]{0,40}(?:文档|说明文字|门槛|质量|太水|没实质)|(?:文档型|说明型|水(?:PR|pr)|琐碎)(?:改动|PR|pr)[^。！？!?\n]{0,24}(?:弹回|拒|关)/i;

/** Stars vs commits/PRs juxtaposition, or "提交数(不是)第一" rank talk. */
const STAR_COMMIT_JUXTAPOSE_RE =
  /\d[\d,]*\s*星[^。！？!?\n]{0,48}(?:\d+\s*个?\s*(?:提交|PR|pr|commit)|堆进去|打满)|(?:\d+\s*个?\s*(?:提交|PR|pr|commit)|打满|堆进去)[^。！？!?\n]{0,48}\d[\d,]*\s*星|不是?\s*提交数\s*第一|提交数\s*(?:不是)?第一|top\s*committer|not\s+the\s+top\s+committer/i;
/** "N commits … 却/只 …" outcome contrast (commits vs what landed). */
const COMMIT_OUTCOME_CONTRAST_RE =
  /(?:\d+\s*(?:个|次)?\s*(?:提交|commits?)|(?:提交|commits?)\s*(?:到了|了)?\s*\d+)[^。！？!?\n]{0,64}(?:却|只)(?:是|留下|合[入进]|落地|做成|改成)?/i;
/** "N 个提交、合进 M 个 PR" commits↔merged-count juxtaposition. */
const COMMIT_MERGED_JUXTAPOSE_RE =
  /\d+\s*个?\s*提交[^。！？!?\n]{0,28}(?:合进|已合并|合并了?)\s*\d+\s*个?\s*(?:已合并\s*)?PR|\d+\s*commits?[^.\n]{0,40}\d+\s*(?:merged\s*)?PRs?/i;
/** Long predominantly-English quotes — paraphrase in Chinese; do not paste repo blurbs. */
const LONG_EN_QUOTE_RE =
  /[「""]\s*[A-Za-z][^」""]{39,}[」""]/;
/** Distinctive metaphor words that must appear at most once per report. */
const METAPHOR_ONCE = [
  "家务", "刻度", "秒表", "发条", "抽屉", "样品瓶", "铭牌", "屏保", "工位",
  "裁判", "便利店", "化石", "后院", "连续剧", "季播",
] as const;
/** Percent-of-work gotchas ("约 65% 是文档", "六成是站点"). */
const PCT_OF_WORK_RE =
  /约?\s*\d+\s*%\s*(?:是|为|都在)|(?:约|接近)?\s*[一二三四五六七八九十两\d]+\s*成\s*(?:是|都|在)|percent\s+of\s+(?:PRs?|commits?|work)/i;
/** Language-share figures — prefer drop; judges flag as fabricated. */
const LANG_SHARE_RE =
  /(?:TypeScript|JavaScript|Python|Go|Rust|Java|C\+\+|C#|Ruby|PHP|Swift|Kotlin|Dart|Shell|HTML|CSS|Vue|Astro|GDScript|Handlebars|SCSS)\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*(?:TypeScript|JavaScript|Python|Go|Rust|Java)|语言[^。！？!?\n]{0,24}\d+\s*%/i;
/** Score-tier restating / meta filler the owner rejected. */
const SCORE_META_FILLER_RE =
  /所以(?:高|低|中|停在|这个分)[^。！？!?\n]{0,24}(?:没到头|没到顶|到不了|停在中段|上不去)|这是日历总数[,，]?不是\s*PR\s*数|这是评分口径本身[,，]?不是界面抛光|不是界面抛光/i;
/** Stiff knife/craft metaphors that pile up. */
const STIFF_METAPHOR_RE =
  /亮仓刀|刀却都在|刀口在|砍一刀|客座刀|(?:你的)?手艺/;
/** Jokes that punch down on a low merged-PR count ("只合了 1 个 PR"). */
const LOW_MERGED_PR_JOKE_RE =
  /(?:只|才|就)\s*(?:合[了进入]?|合并了?|合进了?)\s*\d+\s*个?\s*(?:已合并\s*)?PR|已合并\s*PR\s*就\s*\d+|合进去的已合并\s*PR\s*就\s*\d+|PR\s*就\s*1\s*个|作业交了一份/;
/** Meta filler about the scanner itself ("扫描没有关闭原因"). */
const SCAN_META_FILLER_RE =
  /扫描没有[^。！？!?\n]{0,16}原因|扫描(?:只|仅)有计数|没有关闭原因|扫描仪?没有|scan\s+has\s+no\s+clos(?:e|ing)\s+reason/i;
/** Third-person gendered pronouns — always address as 你. Skip 其他/他人. */
const GENDERED_PRONOUN_RE =
  /(?<![其])她|(?<![其])他(?![人们])/;
/** Open-issue backlog framed as a flaw — users read this as "issues hurt the score".
 *  Do NOT match neutral "开过 N 个 issue" (issues_created); require backlog/open/pending framing. */
const ISSUE_BACKLOG_RE =
  /(?:\d+\s*个?(?:开放|待清|挂着的?)\s*(?:Issue|issue|议题)|(?:开放|待清|挂着)\s*\d+\s*个?(?:Issue|issue|议题)|(?:Issue|issue|议题)\s*(?:堆肥|积压|欠账|清道夫)|待清\s*(?:Issue|issue)|清一批\s*(?:Issue|issue|开放)|(?:Issue|issue)\s*Composter|issue\s*backlog|(?:挂着|堆着)\s*(?:一串|[\d]+\s*个?)?\s*(?:open\s*)?(?:Issue|issue)|再加功能[，,].{0,24}(?:Issue|issue)|清(?:掉|完|理)?(?:一批)?\s*(?:开放\s*)?(?:Issue|issue).{0,16}(?:再谈|再发|再做|release)|(?:\d+\s*个\s*)?open\s*(?:Issue|issue)s?(?:\s*等着)?|关掉那\s*\d+\s*个\s*open\s*(?:Issue|issue)|\d+\s*(?:open\s+)?(?:issues?)\s*(?:still\s+)?(?:open|pending|hanging)|(?:open|pending)\s+\d+\s*(?:open\s+)?(?:issues?))/i;
/** Implying a metric caused a score deduction — scores are opaque to copy. */
const SCORE_ATTRIBUTION_RE =
  /(?:因此|所以|于是).{0,12}(?:被)?(?:扣分|减分|拉低|压分|扣了|降分)|(?:扣分|减分|拉低分数|评分引擎|被评分).{0,8}(?:因为|由于|源自)|(?:因为|由于).{0,20}(?:被)?(?:扣分|减分|拉低|压到)/;
/** Famous-repo vs tiny-contribution diminishing contrast ("却" / "那一笔"). */
const DIMINISHING_CONTRAST_RE =
  /(?:在|于).{0,40}(?:上做协作者|上做贡献|上客座|合进).{0,24}(?:那一笔却|合进去的那一笔却|却是|却只是)|(?:那一笔却是|合进去的那一笔却)|(?:大仓|名仓|明星仓|高星).{0,24}(?:却|那一笔)/;
/** Counts of maintainer-closed-unmerged or self-closed PRs — trivial negative stats. */
const CLOSED_PR_COUNT_RE =
  /(?:被维护者关闭且?未合并|维护者关闭且?未合并|维护者关闭未合并).{0,8}\d+|\d+\s*个?(?:PR|pr)?.{0,12}(?:被维护者关闭且?未合并|维护者关闭且?未合并)|(?:你自己关闭|作者(?:自己|主动)?关闭|自[己行]关闭).{0,12}(?:外部\s*)?(?:PR|pr).{0,8}\d+|\d+\s*个?(?:外部\s*)?(?:PR|pr).{0,12}(?:你自己关闭|作者(?:自己|主动)?关闭|自[己行]关闭)|self[- ]?closed\s*(?:external\s*)?PRs?|maintainer[- ]?closed\s*(?:unmerged\s*)?PRs?/i;
/** Credit-belittling / share-discount put-downs. */
const CREDIT_BELITTLING_RE =
  /(?:仍?是别人的|别人的运行时|别人的仓|原作者名下|挂在.{0,12}原作者|署名留在|留在门厅|被依赖的仓不是你发起|不是你发起的|按份额折完|折完份额|影响仍挂在)/;

function countNumbers(text: string): number {
  // Collapse ISO dates so "2022-07-21" counts as one evidence token, not three.
  const normalized = text.replace(/\d{4}-\d{2}-\d{2}/g, "DATE");
  return (normalized.match(/\d+(?:\.\d+)?/g) ?? []).length;
}

function numberDensityIssues(field: string, text: string): V13Issue[] {
  const out: V13Issue[] = [];
  for (const s of sentences(text)) {
    const n = countNumbers(s);
    const sentMax = field.startsWith("findings") ? 1 : field.startsWith("dimensions.") ? 2 : 2;
    if (n > sentMax) {
      out.push({
        kind: "trivia",
        field,
        detail: `number density: sentence has ${n} numbers (max ${sentMax}) — "${s.slice(0, 48)}"`,
      });
    }
  }
  const cap = field.startsWith("dimensions.") ? 2 : field.startsWith("findings") ? 1 : field === "roast_line" || field.endsWith(".zh") || field.endsWith(".en") ? 2 : 3;
  const total = countNumbers(text);
  if (total > cap) {
    out.push({ kind: "trivia", field, detail: `number density: field has ${total} numbers (max ${cap})` });
  }
  return out;
}

/**
 * Trivia hooks the owner rejected: follower counts (everywhere), activity time
 * windows, days-since filler, vague "厚度", ANY share-count contrast (including
 * dimensions), mislabeling credited/折算 stars as 名下总星, invented PR close
 * reasons, gamey advice, number-density caps, and token PRs to famous repos.
 */
/** "只合了 1 个 PR" / "那个 PR" / "only one PR" in a one-liner. */
const PR_COUNT_RE = /(只|仅|就|才|那)(合进去?的?|合并的?|有|提了?|开了?)?(你|她|他)?\s*(那|一|1|两|2|三|3|几)?\s*个\s*PR|\bonly (one|two|three|a few|\d) (merged )?PRs?\b/i;

export function checkTrivia(index: FactIndex, field: string, text: string): V13Issue[] {
  const issues: V13Issue[] = [];
  // Tags: reject follower-ratio / time-window / thickness gotchas by name.
  if (field.startsWith("tags")) {
    if (isTriviaTag(text) || /^(?:协作者|维护者|贡献者|Owner|OWNER|Collaborator|Maintainer|Contributor|Committer)$/i.test(text.trim())) {
      issues.push({ kind: "trivia", field, detail: "tag names a trivial stat or bare role, not substance" });
    }
    return issues;
  }
  // Follower/following counts banned from every prose field (community row too).
  if (FOLLOW_RE.test(text) || FOLLOWER_COUNT_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "follower/following counts are banned everywhere — rewrite around the work" });
  }
  if (WINDOW_RE.test(text) || DAYS_SINCE_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "activity time window / days-since filler is not a roast hook" });
  }
  if (THICKNESS_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "vague '厚度' is not a roast hook; name the project or gap" });
  }
  if (SHARE_CONTRAST_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "share-count contrast (N里M个 / M个是你的 / X of Y) is banned — absolute counts and qualitative roles only" });
  }
  if (STAR_COMMIT_JUXTAPOSE_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "stars-vs-commits juxtaposition or 提交数第一 rank talk is banned — write what the work is" });
  }
  if (COMMIT_OUTCOME_CONTRAST_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "N-commits-却/只 outcome contrast is banned — say what landed and why it matters" });
  }
  if (COMMIT_MERGED_JUXTAPOSE_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "commits↔merged-PR count juxtaposition is banned — write the work, not N提交/M合入" });
  }
  if (LONG_EN_QUOTE_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "long English verbatim quote — paraphrase in Chinese or drop" });
  }
  if (PCT_OF_WORK_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "percent-of-PRs/work gotcha is banned — describe the work, not the share" });
  }
  if (LANG_SHARE_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "language-share percentages are banned — name the stack without % figures" });
  }
  if (SCORE_META_FILLER_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "score-tier restating / meta filler (所以高但没到头 / 日历总数不是PR数) is banned" });
  }
  if (STIFF_METAPHOR_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "stiff knife/手艺 metaphors are banned — witty framing from the work itself" });
  }
  if (LOW_MERGED_PR_JOKE_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "low merged-PR-count joke is banned — write what the one PR did, not that there was only one" });
  }
  if (SCAN_META_FILLER_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "scan-meta filler (扫描没有关闭原因) is banned — omit the reason or drop the clause" });
  }
  if (GENDERED_PRONOUN_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "never infer gender — address the subject as 你 / you" });
  }
  if (CREDITED_AS_OWNED_STARS_RE.test(text) && !/折算|计入|credited/i.test(text)) {
    issues.push({ kind: "trivia", field, detail: "metrics.total_stars is credited/折算 stars — say 折算/计入, never 名下总星/名下仓库总星" });
  }
  if (INVENTED_CLOSE_REASON_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "do not invent why PRs were closed — count only, no fabricated close reasons" });
  }
  if (/\bOWNER\b|标成\s*OWNER|标成所有者/i.test(text)) {
    issues.push({ kind: "trivia", field, detail: "do not claim OWNER — only state roles from the card facts.role field in plain words" });
  }
  if (field.startsWith("advice") && GAMEY_ADVICE_RE.test(text)) {
    issues.push({ kind: "trivia", field, detail: "gamey advice (chase commits/stars/followers) — suggest what to build/ship/write/OSS next" });
  }
  if (ISSUE_BACKLOG_RE.test(text)) {
    issues.push({
      kind: "trivia",
      field,
      detail: "open-issue count as backlog/flaw is banned — many open issues usually mean an active project; omit or frame neutrally/positively without counts in tags/title/findings/advice",
    });
  }
  if (SCORE_ATTRIBUTION_RE.test(text)) {
    issues.push({
      kind: "trivia",
      field,
      detail: "do not attribute a score deduction to a metric — describe the work, never imply the scorer deducted points for it",
    });
  }
  if (DIMINISHING_CONTRAST_RE.test(text)) {
    issues.push({
      kind: "trivia",
      field,
      detail: "diminishing contrast (famous repo + 却/那一笔 tiny contribution) is banned — frame what you built positively",
    });
  }
  if (CLOSED_PR_COUNT_RE.test(text)) {
    issues.push({
      kind: "trivia",
      field,
      detail: "maintainer-closed-unmerged / self-closed PR counts are banned everywhere — omit these trivial negative stats",
    });
  }
  if (CREDIT_BELITTLING_RE.test(text)) {
    issues.push({
      kind: "trivia",
      field,
      detail: "credit-belittling / share-discount lines are banned — do not say credit belongs to someone else or '按份额折完'; ecosystem gap as opportunity is fine",
    });
  }
  issues.push(...numberDensityIssues(field, text));
  if (/^(roast_line|title)/.test(field)) {
    if (PR_COUNT_RE.test(text)) issues.push({ kind: "trivia", field, detail: "a PR count is not a one-liner hook" });
    if (DESC_WORD.test(text) && [...text.matchAll(QUOTE_RE)].length > 0) {
      issues.push({ kind: "trivia", field, detail: "wordplay on a repository description is not a one-liner hook" });
    }
  }
  if (index.hasMajorWork) {
    const lower = text.toLowerCase();
    for (const [key, work] of index.work) {
      // Token touch to a famous repo (≤15 lifetime PRs+commits) is not a point.
      if ((index.repos.get(key) ?? 0) < 10_000 || work > 15) continue;
      const name = key.split("/")[1];
      // Full owner/repo, or the bare repo name as a standalone word.
      const bare = name.length >= 3 && new RegExp(`(^|[^a-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_-])`).test(lower);
      if (lower.includes(key) || bare) {
        issues.push({ kind: "trivia", field, detail: `a few PRs to famous ${key} is not a point when the account has real work elsewhere` });
      }
    }
  }
  return issues;
}

export function checkCliches(field: string, text: string, lang: "zh" | "en"): V13Issue[] {
  const list: readonly string[] = field.endsWith(".en") || lang === "en"
    ? [...V13_CLICHE_PHRASES_EN, ...(field.endsWith(".en") ? [] : V13_CLICHE_PHRASES)]
    : V13_CLICHE_PHRASES;
  const lower = text.toLowerCase();
  return list
    .filter((p) => lower.includes(p.toLowerCase()))
    .map((p) => ({ kind: "cliche" as const, field, detail: `cliché "${p}"` }));
}

/** Insulting / 嘴臭 lexicon — objective teasing witty tone only. */
export function checkSnark(field: string, text: string, lang: "zh" | "en"): V13Issue[] {
  const list: readonly string[] = field.endsWith(".en") || lang === "en"
    ? [...V13_SNARK_BANNED_EN, ...(field.endsWith(".en") ? [] : V13_SNARK_BANNED_ZH)]
    : V13_SNARK_BANNED_ZH;
  const lower = text.toLowerCase();
  return list
    .filter((p) => lower.includes(p.toLowerCase()))
    .map((p) => ({
      kind: "snark" as const,
      field,
      detail: `snark/insult "${p}" — rewrite as objective teasing witty observation`,
    }));
}

export function validateCopy(index: FactIndex, copy: V13Copy, lang: "zh" | "en"): V13Issue[] {
  const issues: V13Issue[] = [];
  if (!copy.roast_line.zh) issues.push({ kind: "schema", field: "roast_line.zh", detail: "missing" });
  if (!copy.roast_line.en) issues.push({ kind: "schema", field: "roast_line.en", detail: "missing" });
  if (/[㐀-鿿]/.test(copy.roast_line.en)) {
    issues.push({ kind: "language", field: "roast_line.en", detail: "English roast line contains Chinese" });
  }
  if (copy.findings.length < 2) issues.push({ kind: "schema", field: "findings", detail: "need 3 findings" });
  for (const { field, text } of copyFields(copy)) {
    issues.push(...checkText(index, field, text), ...checkCliches(field, text, lang), ...checkSnark(field, text, lang), ...checkTrivia(index, field, text));
    if (field !== "roast_line.zh" && field !== "roast_line.en" && !field.startsWith("tags") && field !== "title" &&
        repeatsRoastLine(copy.roast_line.zh, text)) {
      issues.push({ kind: "repeat", field, detail: "restates the one-liner; say something new here" });
    }
  }
  copy.findings.forEach((f, i) => {
    if (f.headline && copy.title && normQuote(f.headline) === normQuote(copy.title)) {
      issues.push({ kind: "repeat", field: `findings[${i}].headline`, detail: "repeats the title" });
    }
  });
  issues.push(...metaphorOnceIssues(copy));
  issues.push(...findingSubjectIssues(copy));
  return issues;
}


/** Each finding must stay on one subject; body must name what the headline points at. */
function findingSubjectIssues(copy: V13Copy): V13Issue[] {
  const out: V13Issue[] = [];
  const repoRe = /`?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+`?/g;
  copy.findings.forEach((f, i) => {
    const text = f.text || "";
    const head = f.headline || "";
    const repos = [...new Set((text.match(repoRe) || []).map((r) => r.replace(/`/g, "").toLowerCase()))];
    // Abrupt subject jump: 2+ distinct repos AND a mid-sentence pivot like "回到/另|隔壁仓已说过的另一仓"
    if (repos.length >= 2 && /[。；;]\s*(?:回到|另[一外]?边?|再看|至于|而在)/.test(text)) {
      out.push({
        kind: "trivia",
        field: `findings[${i}].text`,
        detail: "finding jumps subjects mid-way — keep one subject per finding",
      });
    }
    // Title mentions a notes/blog-ish noun but body never names a concrete repo/subject token from title
    const titleTokens = head.replace(/[的与和及]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
    const bodyHasTitleHook = titleTokens.some((tok) => text.includes(tok));
    const bodyHasRepo = repos.length > 0;
    // If headline is non-empty and body has neither a title token nor any named repo, flag.
    // (loose: only when body uses vague 旁边/那边 without a named subject)
    if (head && /旁边|那边|那份|上述/.test(text) && !bodyHasRepo) {
      out.push({
        kind: "trivia",
        field: `findings[${i}].text`,
        detail: "finding body must name the subject its title refers to (no dangling 旁边)",
      });
    }
  });
  return out;
}

/** Any distinctive metaphor word may appear at most once across the whole report. */
function metaphorOnceIssues(copy: V13Copy): V13Issue[] {
  const prose = [
    copy.roast_line.zh,
    copy.verdict,
    ...copy.findings.map((f) => `${f.headline}${f.text}`),
    ...Object.values(copy.dimensions),
    ...copy.advice,
    copy.risk,
  ].join("\n");
  const out: V13Issue[] = [];
  for (const word of METAPHOR_ONCE) {
    let n = 0;
    let from = 0;
    while (from < prose.length) {
      const i = prose.indexOf(word, from);
      if (i < 0) break;
      n++;
      from = i + word.length;
    }
    if (n > 1) {
      out.push({
        kind: "repeat",
        field: "report",
        detail: `metaphor "${word}" used ${n} times — keep any distinctive metaphor to once per report`,
      });
    }
  }
  return out;
}

/** Remove sentences that still cite a repo/number/star count absent from the
 * data after the editor pass. Returns the cleaned copy and what was dropped. */
/** Trim over-long slot prose to the last full sentence that fits max. Under-length left for the editor. */
export function fitSlotLengths(copy: V13Copy, lang: "zh" | "en"): V13Copy {
  const fit = (slot: SlotName, text: string): string => {
    if (!text) return text;
    const { max } = slotRange(slot, lang);
    if ([...text].length <= max) return text;
    const parts = sentences(text);
    let acc = "";
    for (const s of parts) {
      const next = acc + s;
      if ([...next].length > max) break;
      acc = next;
    }
    const out = acc.trim() || [...text].slice(0, max).join("").trim();
    return out;
  };
  return {
    ...copy,
    roast_line: {
      zh: fit("roast_line", copy.roast_line.zh),
      en: copy.roast_line.en, // en uses its own factor via slotRange only for zh-primary pipeline
    },
    title: fit("title", copy.title),
    verdict: fit("verdict", copy.verdict),
    findings: copy.findings.map((f) => ({
      ...f,
      headline: fit("finding_headline", f.headline),
      text: fit("finding", f.text),
    })),
    dimensions: Object.fromEntries(
      Object.entries(copy.dimensions).map(([k, v]) => [k, fit("dimension", v)]),
    ) as V13Copy["dimensions"],
    advice: copy.advice.map((a) => fit("advice", a)),
  };
}

export function dropUnverifiedSentences(
  index: FactIndex,
  copy: V13Copy,
): { copy: V13Copy; dropped: string[] } {
  const dropped: string[] = [];
  const roast = copy.roast_line.zh;
  const clean = (field: string, text: string): string => {
    if (!text) return text;
    const parts = sentences(text);
    const kept = parts.filter((s) => {
      const bad =
        s.includes(BAD_QUOTE) ||
        checkText(index, field, s).some((i) => i.kind !== "cliche") ||
        checkTrivia(index, field, s).some((i) => !/one-liner hook/.test(i.detail)) ||
        (/^(findings|dimensions|advice)/.test(field) && wording(s).length >= 12 && coverage(s, roast) >= 0.7);
      if (bad) dropped.push(`${field}: ${s.trim()}`);
      return !bad;
    });
    return kept.join("").trim();
  };
  const next: V13Copy = {
    ...copy,
    tags: {
      zh: copy.tags.zh.filter((t) => !isTriviaTag(t)),
      en: copy.tags.en.filter((t) => !isTriviaTag(t)),
    },
    verdict: clean("verdict", copy.verdict),
    risk: clean("risk", copy.risk),
    findings: copy.findings
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => {
        const repeat = copy.findings.length > 1 && repeatsRoastLine(roast, f.text);
        if (repeat) dropped.push(`findings[${i}]: restates the one-liner`);
        return !repeat;
      })
      .map(({ f, i }) => ({
        i,
        headline: f.headline && copy.title && normQuote(f.headline) === normQuote(copy.title) ? "" : f.headline,
        text: clean(`findings[${i}].text`, f.text),
      }))
      .filter((f) => f.text),
    dimensions: Object.fromEntries(
      Object.entries(copy.dimensions).map(([k, v]) => [k, clean(`dimensions.${k}`, v)]),
    ),
    advice: [],
  };
  const advice = copy.advice.map((a, i) => ({ i, text: clean(`advice[${i}]`, a) })).filter((a) => a.text);
  next.advice = advice.map((a) => a.text);
  // Re-key citations to the surviving findings/advice.
  const findings = next.findings as unknown as { i: number; headline: string; text: string }[];
  if (copy.cites) {
    const cites: Record<string, string[]> = Object.fromEntries(
      Object.entries(copy.cites).filter(([k]) => !/^(findings|advice)\[/.test(k)),
    );
    findings.forEach((f, j) => (cites[`findings[${j}]`] = copy.cites![`findings[${f.i}]`] ?? []));
    advice.forEach((a, j) => (cites[`advice[${j}]`] = copy.cites![`advice[${a.i}]`] ?? []));
    next.cites = cites;
  }
  next.findings = findings.map(({ headline, text }) => ({ headline, text }));
  return { copy: next, dropped };
}

// ---------------------------------------------------------------------------
// Slotted copy: quote tokens, card citations and slot lengths.

const TOKEN_RE = /\{\{\s*q\s*:\s*(c\d+)(?:\s*#\s*(\d+))?\s*\}\}/g;
/** Marker for a token that named no card quote; its sentence is dropped. */
export const BAD_QUOTE = "\u2063BADQUOTE\u2063";

/** Replace {{q:cN}} / {{q:cN#k}} with the card's verbatim text in quotes. */
export function fillQuoteTokens(text: string, cards: FactCard[], lang: "zh" | "en"): string {
  if (!text) return text;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const [open, close] = lang === "en" ? ["\u201c", "\u201d"] : ["「", "」"];
  return text.replace(TOKEN_RE, (_m, id: string, n?: string) => {
    const q = byId.get(id)?.quotes?.[n ? Number(n) - 1 : 0];
    return q ? `${open}${q.text}${close}` : BAD_QUOTE;
  });
}

export function fillCopyQuotes(copy: V13Copy, cards: FactCard[], lang: "zh" | "en"): V13Copy {
  const f = (t: string, l: "zh" | "en" = lang) => fillQuoteTokens(t, cards, l);
  return {
    ...copy,
    title: f(copy.title),
    roast_line: { zh: f(copy.roast_line.zh, "zh"), en: f(copy.roast_line.en, "en") },
    verdict: f(copy.verdict),
    risk: f(copy.risk),
    findings: copy.findings.map((x) => ({ headline: f(x.headline), text: f(x.text) })),
    dimensions: Object.fromEntries(Object.entries(copy.dimensions).map(([k, v]) => [k, f(v)])),
    advice: copy.advice.map((a) => f(a)),
  };
}

const charLen = (t: string) => [...t].length;

/** Slot lengths, card citations and distinct roast points. */
export function checkSlots(copy: V13Copy, cards: FactCard[], lang: "zh" | "en"): V13Issue[] {
  const issues: V13Issue[] = [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  const cites = copy.cites ?? {};
  const len = (field: string, slot: SlotName, text: string, l: "zh" | "en" = lang) => {
    if (!text) return;
    const { min, max } = slotRange(slot, l);
    const n = charLen(text);
    if (n > max) issues.push({ kind: "length", field, detail: `${n} chars, slot allows ${min}-${max}; cut filler` });
    else if (n < min) issues.push({ kind: "length", field, detail: `${n} chars, slot needs ${min}-${max}; add evidence from the cards` });
  };
  const cite = (field: string, slot: SlotName) => {
    const ids = cites[field] ?? [];
    const known = ids.filter((id) => byId.has(id));
    if (ids.length > known.length) {
      issues.push({ kind: "cite", field, detail: `unknown card ids ${ids.filter((id) => !byId.has(id)).join(",")}` });
    }
    if (!known.length) issues.push({ kind: "cite", field, detail: "cite the card(s) this text rests on" });
    else if (SLOTS[slot].hook && !known.some((id) => byId.get(id)!.hook)) {
      issues.push({ kind: "trivia", field, detail: "rests only on context cards (followers, calendar, account age); use a hook card" });
    }
  };
  len("roast_line.zh", "roast_line", copy.roast_line.zh, "zh");
  cite("roast_line", "roast_line");
  len("title", "title", copy.title);
  len("verdict", "verdict", copy.verdict);
  cite("verdict", "verdict");
  const primaries = new Set<string>();
  copy.findings.forEach((f, i) => {
    len(`findings[${i}].headline`, "finding_headline", f.headline);
    len(`findings[${i}].text`, "finding", f.text);
    cite(`findings[${i}]`, "finding");
    const first = (cites[`findings[${i}]`] ?? [])[0];
    if (first && primaries.has(first)) {
      issues.push({ kind: "repeat", field: `findings[${i}]`, detail: `same main card ${first} as an earlier point; use another card` });
    }
    if (first) primaries.add(first);
  });
  for (const [k, v] of Object.entries(copy.dimensions)) {
    len(`dimensions.${k}`, "dimension", v);
  }
  copy.advice.forEach((a, i) => {
    len(`advice[${i}]`, "advice", a);
    cite(`advice[${i}]`, "advice");
  });
  return issues;
}
