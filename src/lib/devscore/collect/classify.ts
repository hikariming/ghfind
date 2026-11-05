/**
 * devscore collector classifiers and pure helpers (port of collector/collect.py: the
 * "classifiers" section and every pure function the collection phases use). No I/O.
 *
 * Regexes keep collect.py's pattern text verbatim and go through `pyRe`, which gives them
 * Python `re` semantics on str patterns: Unicode `\w`/`\b`/`\s`, `$` also before a final
 * newline, `.` excluding only `\n`, and re.I's extra matches of `i` (U+0130, U+0131).
 */

/** Python's `\w` on str: every letter and number, plus `_`. */
const WORD = String.raw`\p{L}\p{N}_`;
/** Python's `\s` on str (str.isspace). */
const SPACE = String.raw`\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
/** Under re.I Python also matches `i`/`I` to U+0130 and U+0131; JS simple case folding does not. */
const DOTTED_I = "\u0130\u0131";

/**
 * A Python `re` pattern (str, no MULTILINE/DOTALL) as a JS RegExp with the same matches.
 * `.search()` is `.test()`; for `re.match` the pattern must start with `^`.
 */
export function pyRe(src: string, ignoreCase = false): RegExp {
  let out = "";
  let cls: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[++i];
      if (cls !== null) {
        if (n === "w") cls += WORD;
        else if (n === "s") cls += SPACE;
        else if (/[A-Za-z0-9]/.test(n)) throw new Error(`pyRe: unsupported class escape \\${n} in ${src}`);
        else cls += "\\" + n;
      } else if (n === "w") out += `[${WORD}]`;
      else if (n === "s") out += `[${SPACE}]`;
      else if (n === "S") out += `[^${SPACE}]`;
      else if (n === "b") out += BOUNDARY;
      else if (/[A-Za-z0-9]/.test(n)) throw new Error(`pyRe: unsupported escape \\${n} in ${src}`);
      else out += "\\" + n;
    } else if (cls !== null) {
      if (c !== "]") {
        cls += c;
        continue;
      }
      if (ignoreCase && new RegExp(cls + "]", "iu").test("i") !== cls.startsWith("[^")) {
        if (cls.startsWith("[^")) throw new Error(`pyRe: negated class excluding i under re.I in ${src}`);
        cls = "[" + DOTTED_I + cls.slice(1); // at the start: a trailing `-` would form a range
      }
      out += cls + "]";
      cls = null;
    } else if (c === "[") {
      cls = "[";
      if (src[i + 1] === "^") cls += src[++i];
    } else if (c === "$") out += "(?=\\n?$)";
    else if (c === ".") out += "[^\\n]";
    else if (ignoreCase && (c === "i" || c === "I")) out += `[iI${DOTTED_I}]`;
    else out += c;
  }
  if (cls !== null) throw new Error(`pyRe: unterminated class in ${src}`);
  return new RegExp(out, ignoreCase ? "iu" : "u");
}

/** Python `str.strip()` whitespace. */
const STRIP = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");

/** Python sort key comparison for tuples of numbers/strings (code point order for strings). */
function cmpKeys(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return cmpStr(String(x), String(y));
  }
  return 0;
}

function cmpStr(a: string, b: string): number {
  // Python compares code points; UTF-16 order differs only between astral and U+E000..U+FFFF
  const ca = [...a];
  const cb = [...b];
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const d = ca[i].codePointAt(0)! - cb[i].codePointAt(0)!;
    if (d) return d;
  }
  return ca.length - cb.length;
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------- helpers

export function monthKey(ts: string): string {
  return ts.slice(0, 7);
}

/** Scale a sampled category histogram to `total` (largest-remainder rounding). */
export function scaleCounts(counts: Record<string, number>, total: number): Record<string, number> {
  const keys = Object.keys(counts);
  const s = keys.reduce((a, k) => a + counts[k], 0);
  const raw: Record<string, number> = {};
  const out: Record<string, number> = {};
  for (const k of keys) {
    raw[k] = (counts[k] * total) / s;
    out[k] = Math.trunc(raw[k]);
  }
  const left = total - keys.reduce((a, k) => a + out[k], 0);
  // Python sorted(reverse=True) is stable: equal remainders keep insertion order
  const byRemainder = [...keys].sort((a, b) => raw[b] - out[b] - (raw[a] - out[a]));
  for (const k of byRemainder.slice(0, left)) out[k] += 1;
  return out;
}

// ---------------------------------------------------------------- classifiers

export const SITE_NAME = pyRe(String.raw`(-site|\.github\.io|Site|[-_.]?website|[-_.]homepage|[-_.]landing(-page)?)$`);
export const SITE_DESC = pyRe(
  String.raw`\b(official (web)?site|(source|code) (of|for) [\w\s.-]*(web)?site|documentation (web)?site` +
    String.raw`|docs? site|personal (web)?site|used to build [\w.-]+\.[a-z]{2,}` +
    String.raw`|my (personal )?(web ?site|blog|homepage|portfolio)|portfolio (web)?site)\b`,
  true,
);
export const DOCS_NAME = pyRe(String.raw`(^|[-_.])(docs?|documentation|wiki|handbook|tutorials?|book)([-_.]|$)`, true);
// contract v9: talks and slide decks are content, not code
export const TALK_NAME = pyRe(
  String.raw`(^|[-_.])(slides?|talks?|presentations?|decks?|workshops?|speaking|keynotes?)([-_.]|$)`,
  true,
);
export const TALK_DESC = pyRe(String.raw`\b(slides|talk|presentation|workshop|keynote) (from|for|at|about)\b`, true);
export const CONFIG_NAME = pyRe(
  String.raw`(^\.?dotfiles?$|dotfiles|^\.?config$|^(n?vim|emacs|zsh|bash)[-_.]?(rc|config|conf)$` +
    String.raw`|[-_.]config(s)?$|^\.?(vimrc|zshrc|bashrc|emacs\.d)$)`,
  true,
);

export const SITE_DIRS = pyRe(
  String.raw`^(website|site|www|docs-site|blog|homepage|web-?site|src/pages|i18n/[^/]+/docusaurus)`,
  true,
);
export const DOC_EXT = pyRe(String.raw`\.(md|mdx|rst|txt|adoc)$`, true);
// Markup, styles, media and data: slides, email templates, drawings and datasets are not
// product code. Components live in .vue/.tsx/.svelte.
export const ASSET_EXT = pyRe(
  String.raw`\.(html?|css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|pdf|mp4|webm|mp3|wav` +
    String.raw`|ttf|otf|woff2?|eot|csv|tsv|geojson|parquet|xlsx?|ipynb` +
    String.raw`|json|jsonl|ya?ml|toml|xml|ini)$`,
  true,
);
// contract v14: DATA_EXT is data wherever it lives; DATA_DIR_FILE covers text formats that are
// code or config elsewhere but data inside a data directory. READMEs there stay docs.
export const DATA_EXT = pyRe(
  String.raw`\.(wpt|rlist|alist|csv|tsv|geojson|topojson|gpx|kml|kmz|parquet|jsonl|ndjson` +
    String.raw`|npy|npz|h5|hdf5|arff|xlsx?)$`,
  true,
);
export const DATA_DIR_FILE = pyRe(
  String.raw`(^|/)(data|datasets?|[\w.-]+_(data|files))/(.*/)?(?!readme)[^/]*` +
    String.raw`\.(txt|json|ya?ml|xml|list|dat)$`,
  true,
);
export const I18N_FILE = pyRe(String.raw`(^|/)(i18n|locales?|lang|langs|translations?|messages)/.*\.(json|ya?ml)$`, true);
export const TEST_FILE = pyRe(
  String.raw`(^|/)(tests?|__tests__|spec|specs|e2e|testdata|fixtures)/` +
    String.raw`|[._-](test|spec)\.[a-z]+$|_test\.go$|(^|/)test_[^/]+\.py$`,
  true,
);
export const CHORE_FILE = pyRe(
  String.raw`(^|/)\.github/|(^|/)\.circleci/|(^|/)\.gitlab-ci|(^|/)\.travis` +
    String.raw`|(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock` +
    String.raw`|uv\.lock|Gemfile\.lock|composer\.lock|bun\.lockb?)$` +
    String.raw`|(^|/)(Dockerfile|docker-compose[^/]*|Makefile|\.gitignore|\.gitattributes` +
    String.raw`|\.editorconfig|\.pre-commit-config\.yaml|\.npmrc|\.nvmrc|renovate\.json|\.releaserc[^/]*` +
    String.raw`|\.eslintrc[^/]*|\.prettierrc[^/]*|tsconfig[^/]*\.json|biome\.json|lefthook\.yml` +
    String.raw`|\.dockerignore|codecov\.ya?ml|CODEOWNERS)$`,
  true,
);
// Branch-sync PRs carry other people's code ("merge master into feature", "sync ...",
// "chore: merge feature"). They are checked before any other rule.
const BRANCH = String.raw`(master|main|develop|dev|next|feature[\w/-]*|release[\w/.-]*|upstream|origin/\S+|'[^']+'|` + "`[^`]+`)";
export const MERGE_TITLE = pyRe(
  String.raw`^\s*((chore|ci|build)(\([^)]*\))?:\s*)?(merge|sync|rebase)\s+${BRANCH}(\s+(into|to|with)\s+${BRANCH})?\s*$` +
    String.raw`|^\s*((chore|ci|build)(\([^)]*\))?:\s*)?(merge|sync)\s+${BRANCH}\s+(into|to|with)\b` +
    String.raw`|^\s*Merge (branch|pull request|remote-tracking)\b`,
  true,
);
export const TITLE_KIND: readonly (readonly [string, RegExp])[] = [
  ["docs", pyRe(String.raw`^\s*(docs?|documentation|readme)\b|^\s*\w+\(docs?\)|\b(typo|readme)\b`, true)],
  ["test", pyRe(String.raw`^\s*tests?\b|^\s*\w+\(tests?\)|\badd(ed)? tests?\b`, true)],
  [
    "chore",
    pyRe(
      String.raw`^\s*(chore|ci|build|deps|bump|release|style)\b|^\s*\w+\((ci|deps|build)\)` +
        String.raw`|\bbump\b|\bupgrade dependenc`,
      true,
    ),
  ],
];

// contract v8 "content": root holds no code file, build manifest or code directory, but ≥ 1
// markdown file. Manifests and monorepo dirs keep repos with code only in subdirectories out.
export const CODE_EXT: Record<string, true> = { py: true, js: true, ts: true, tsx: true, jsx: true, go: true, rs: true, c: true, cc: true, cpp: true, h: true, hpp: true, java: true, kt: true, swift: true, rb: true, php: true, cs: true, scala: true, zig: true, lua: true, dart: true, ex: true, exs: true, hs: true, ml: true, clj: true, sh: true, vue: true, svelte: true };
export const CODE_FILES: Record<string, true> = { makefile: true, dockerfile: true, "cmakelists.txt": true, "meson.build": true, "build.zig": true, "package.json": true, "go.mod": true, "cargo.toml": true, "pyproject.toml": true, "setup.cfg": true, "pom.xml": true, "build.gradle": true, "build.gradle.kts": true, gemfile: true, "composer.json": true, "deno.json": true, "tsconfig.json": true };
export const CODE_DIRS: Record<string, true> = { src: true, lib: true, pkg: true, cmd: true, app: true, crates: true, packages: true, internal: true, include: true, backend: true, frontend: true, server: true, client: true, test: true, tests: true };
export const MARKDOWN_EXT: Record<string, true> = { md: true, markdown: true, mdx: true };

/** A root tree entry (GraphQL `object(expression: "HEAD:") { ... on Tree { entries } }`). */
export interface RootEntry {
  name: string;
  type?: string | null;
  extension?: string | null;
}

/** Root tree entries of a markdown/text/data-only repo. */
export function isContentTree(entries: readonly RootEntry[] | null | undefined): boolean {
  if (!entries?.length) return false;
  let markdown = false;
  for (const e of entries) {
    const name = e.name.toLowerCase();
    if (e.type === "tree") {
      if (CODE_DIRS[name] === true) return false;
      continue;
    }
    const ext = (e.extension || "").replace(/^\.+/, "").toLowerCase();
    if (CODE_EXT[ext] === true || CODE_FILES[name] === true) return false;
    markdown ||= MARKDOWN_EXT[ext] === true;
  }
  return markdown;
}

export function repoKind(
  nameWithOwner: string,
  login: string,
  description: string | null | undefined,
  rootEntries: readonly RootEntry[] | null | undefined = null,
): string {
  const slash = nameWithOwner.indexOf("/");
  const owner = nameWithOwner.slice(0, slash);
  const name = nameWithOwner.slice(slash + 1);
  if (name.toLowerCase() === login.toLowerCase() && owner.toLowerCase() === login.toLowerCase()) return "profile";
  if (name.toLowerCase().startsWith("awesome")) return "list";
  if (SITE_NAME.test(name) || (description && SITE_DESC.test(description))) return "site";
  if (CONFIG_NAME.test(name)) return "config";
  if (DOCS_NAME.test(name)) return "docs";
  if (TALK_NAME.test(name) || (description && TALK_DESC.test(description))) return "content";
  if (isContentTree(rootEntries)) return "content";
  return "code";
}

/**
 * The root-tree `content` guess yields to the diffs: a repo whose sampled commits are mostly
 * product code is code; a talk/slide name stays content. Contract v14: a `code` or
 * (non-talk) `content` repo whose sampled non-merge commits are mostly data commits is `data`.
 */
export function kindWithEvidence(
  kind: string,
  nameWithOwner: string,
  sample: readonly { kind: string; substance: number }[] | null | undefined,
): string {
  if ((kind !== "code" && kind !== "content") || !sample || sample.length < 4) return kind;
  const name = nameWithOwner.slice(nameWithOwner.indexOf("/") + 1);
  if (kind === "content" && TALK_NAME.test(name)) return kind;
  const own = sample.filter((c) => c.kind !== "merge");
  if (own.length >= 4 && own.filter((c) => c.kind === "data").length * 2 > own.length) return "data";
  if (kind !== "content") return kind;
  const core = sample.filter((c) => c.kind === "core" && c.substance > 0).length;
  return core * 2 > sample.length ? "code" : kind;
}

/** Per-file PR rule: test, data (contract v14), docs (docs/i18n/assets), chore or core. */
export function fileKind(f: string): string {
  if (TEST_FILE.test(f)) return "test";
  if (DATA_EXT.test(f) || DATA_DIR_FILE.test(f)) return "data";
  if (DOC_EXT.test(f) || I18N_FILE.test(f)) return "docs";
  if (CHORE_FILE.test(f) || f.startsWith(".github/") || f === "package.json") return "chore";
  if (ASSET_EXT.test(f)) return "docs";
  return "core";
}

/** Tie order of classifyPr: earlier wins. */
export const NON_CORE_KINDS = ["test", "data", "chore", "docs"] as const;

/** merge | site | core | test | data | chore | docs */
export function classifyPr(title: string, files: readonly string[] | null | undefined, repoKind: string): string {
  if (MERGE_TITLE.test(title)) return "merge";
  if (repoKind === "site") return "site";
  if (files?.length) {
    if (files.filter((f) => SITE_DIRS.test(f)).length * 2 > files.length) return "site";
    const kinds = files.map(fileKind);
    if (kinds.includes("core")) return "core";
    // no core files: majority of the non-core categories (tie -> test > data > chore > docs)
    let best: string = NON_CORE_KINDS[0];
    let bestCount = -1;
    for (const k of NON_CORE_KINDS) {
      const n = kinds.filter((x) => x === k).length;
      if (n > bestCount) [best, bestCount] = [k, n];
    }
    return best;
  }
  for (const [kind, rx] of TITLE_KIND) if (rx.test(title)) return kind;
  return repoKind === "data" ? "data" : "core";
}

/**
 * Contract v11 heat area of a core file: its directory truncated to the first 2 path
 * components ("crates/core/src/app.rs" -> "crates/core"); a root-level file is its own
 * area. null for non-core files and site directories.
 */
export function coreArea(f: string): string | null {
  if (!f || SITE_DIRS.test(f) || fileKind(f) !== "core") return null;
  const parts = f.split("/");
  return parts.length === 1 ? f : parts.slice(0, -1).slice(0, 2).join("/");
}

const NON_SUBSTANCE = pyRe(
  String.raw`(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|` +
    String.raw`composer\.lock|Gemfile\.lock)$|` +
    String.raw`\.(md|mdx|rst|txt|json|ya?ml|toml|lock|svg|png|jpe?g|gif|snap|csv|min\.js|map` +
    String.raw`|html?|css|scss|sass|less|webp|ico|pdf|mp4|webm|mp3|wav|ttf|otf|woff2?|eot|tsv|geojson|parquet` +
    String.raw`|xlsx?|ipynb)$|` +
    String.raw`(^|/)(docs?|website|site|examples?|test|tests|__tests__|spec|fixtures?|testdata|vendor|dist|build|` +
    String.raw`generated|locales?|i18n)/|` +
    String.raw`(_test|\.test|\.spec|_spec)\.[a-z]+$|\.generated\.|\.pb\.go$`,
  true,
);
export const PR_SUBSTANCE_CAP = 2000;

export interface FileChange {
  path?: string | null;
  additions?: number | null;
  deletions?: number | null;
}

/**
 * Changed lines of hand-written product code in one PR: additions + deletions on files that
 * are not docs, tests, config/data (contract v14: fileKind data too), lockfiles, vendored or
 * generated, capped at PR_SUBSTANCE_CAP.
 */
export function prSubstance(files: readonly FileChange[]): number {
  let n = 0;
  for (const f of files) {
    const p = f.path || "";
    if (!NON_SUBSTANCE.test(p) && fileKind(p) !== "data") n += (f.additions || 0) + (f.deletions || 0);
  }
  return Math.min(n, PR_SUBSTANCE_CAP);
}

/**
 * Kind of one commit from its diff: merge (2+ parents or a branch-sync title), then the PR
 * file rules; a commit that only moves or renames files, or has no file list, is 'chore'.
 */
export function classifyCommit(
  message: string | null | undefined,
  parents: number,
  files: readonly { filename?: string | null; additions?: number | null; deletions?: number | null }[],
): string {
  const head = (message || "").split("\n", 1)[0];
  if (parents > 1 || MERGE_TITLE.test(head)) return "merge";
  const paths = files.map((f) => f.filename || "");
  if (!paths.length) return "chore";
  if (files.reduce((a, f) => a + (f.additions || 0) + (f.deletions || 0), 0) === 0) return "chore"; // pure rename/move/mode change
  return classifyPr(head, paths, "code");
}

// contract v10: engineering-quality signals from the root tree (no extra queries)
export const CI_FILES: Record<string, true> = { ".travis.yml": true, ".circleci": true, ".gitlab-ci.yml": true, "azure-pipelines.yml": true, jenkinsfile: true };
export const TEST_DIRS: Record<string, true> = { test: true, tests: true, spec: true, __tests__: true, testing: true, e2e: true };
export const TEST_ROOT_FILE = pyRe(String.raw`^(.+_test\.[^.]+|test_.+\.py)$`, true);

/**
 * CI configured: `.github/workflows` has ≥ 1 entry or the root holds a known CI config.
 * null when neither the root nor the workflows tree is known.
 */
export function hasCi(
  rootEntries: readonly RootEntry[] | null | undefined,
  workflows: readonly unknown[] | null | undefined,
): boolean | null {
  if (workflows?.length) return true;
  if (rootEntries == null) return null;
  return rootEntries.some((e) => CI_FILES[e.name.toLowerCase()] === true);
}

/** A root test directory or root test files (*_test.*, test_*.py). null when the root is unknown. */
export function hasTests(rootEntries: readonly RootEntry[] | null | undefined): boolean | null {
  if (rootEntries == null) return null;
  return rootEntries.some((e) =>
    e.type === "tree" ? TEST_DIRS[e.name.toLowerCase()] === true : TEST_ROOT_FILE.test(e.name),
  );
}

// ---------------------------------------------------------------- priorities

export function sat(x: number, k: number): number {
  return 1 - Math.exp(-x / k);
}

/**
 * importance_proxy × log1p(commits): which repos get history, /contributors and the diff
 * sample. Forks only (contract v8): stars carry no weight.
 */
export function repoPriority(meta: { forkCount: number }, commits: number): number {
  const imp = 0.05 + 0.95 * sat(meta.forkCount, 2500);
  return imp * Math.log1p(commits);
}

/** repoPriority over the larger of the contribution graph's and the merged list's PR counts. */
export function prSamplePriority(meta: { forkCount: number }, graphPrs: number, listedPrs: number): number {
  return repoPriority(meta, Math.max(graphPrs, listedPrs));
}

/** The user's PRs merged in one repo on one UTC day that make a batch. */
export const BATCH_DAY_MIN = 3;
/** Merged PRs seen below which prBatchShare is unknown. */
export const BATCH_MIN_PRS = 5;

/**
 * Contract v9: share of the user's merged PRs in one repo (deduped by number) merged on a UTC
 * day on which ≥ BATCH_DAY_MIN of them were merged. null below BATCH_MIN_PRS PRs seen.
 */
export function prBatchShare(nodes: readonly ({ number: number; mergedAt?: string | null } | null)[]): number | null {
  const days = new Map<number, string>();
  for (const n of nodes) if (n?.mergedAt) days.set(n.number, n.mergedAt.slice(0, 10));
  if (days.size < BATCH_MIN_PRS) return null;
  const perDay = new Map<string, number>();
  for (const d of days.values()) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  let batched = 0;
  for (const d of days.values()) if (perDay.get(d)! >= BATCH_DAY_MIN) batched++;
  return batched / days.size;
}

// ---------------------------------------------------------------- mergers and repo signals

/** Independent mergers checked for reciprocity per user. */
export const MUTUAL_MERGERS_CAP = 10;
/** Aliased searches per mutual-merger query. */
export const MUTUAL_BATCH = 5;
/** Repos per issue-author query. */
export const SIGNAL_BATCH = 5;

export interface MergedByNode {
  mergedBy?: { login?: string | null; __typename?: string | null } | null;
}

/** prMergers key of a merged PR node: merger login, "[self]", "[bot]"; null if unknown. */
export function mergerKey(node: MergedByNode, login: string): string | null {
  const mb = node.mergedBy;
  if (!mb?.login) return null;
  if (mb.__typename === "Bot" || mb.login.endsWith("[bot]")) return "[bot]";
  return mb.login.toLowerCase() === login.toLowerCase() ? "[self]" : mb.login;
}

/**
 * {merger key: merged PR count} over one repo's merged PR nodes (number → node), ordered by
 * count descending then key; null when no merger is known.
 */
export function prMergers(prs: Record<string, MergedByNode>, login: string): Record<string, number> | null {
  const counts = new Map<string, number>();
  for (const n of Object.values(prs)) {
    const k = mergerKey(n, login);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return Object.fromEntries([...counts].sort((a, b) => cmpKeys([-a[1], a[0]], [-b[1], b[0]])));
}

/**
 * (repo, merger) pairs to check: independent mergers of the external repos with the most
 * merged PRs, at most MUTUAL_MERGERS_CAP distinct mergers (each checked in its first repo).
 */
export function mutualMergerPairs(
  mergers: Record<string, Record<string, number>>,
  mergedCount: Record<string, number>,
): [string, string][] {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  const repos = Object.keys(mergers).sort((a, b) => cmpKeys([-(mergedCount[a] ?? 0), a], [-(mergedCount[b] ?? 0), b]));
  for (const r of repos) {
    for (const m of Object.keys(mergers[r])) {
      if (m === "[self]" || m === "[bot]" || seen.has(m.toLowerCase())) continue;
      if (seen.size >= MUTUAL_MERGERS_CAP) return pairs;
      seen.add(m.toLowerCase());
      pairs.push([r, m]);
    }
  }
  return pairs;
}

/** Distinct issue authors, excluding the repo owner, the user, bots and ghost authors. */
export function issueAuthors(
  nodes: readonly ({ author?: { login?: string | null; __typename?: string | null } | null } | null)[],
  owner: string,
  login: string,
): number {
  const skip = new Set([owner.toLowerCase(), login.toLowerCase()]);
  const out = new Set<string>();
  for (const n of nodes) {
    const a = n?.author;
    const who = (a?.login || "").toLowerCase();
    if (who && !skip.has(who) && a?.__typename !== "Bot" && !who.endsWith("[bot]")) out.add(who);
  }
  return out.size;
}

// ---------------------------------------------------------------- ecosyste.ms dependents

export const ECO_LOOKUP = "https://packages.ecosyste.ms/api/v1/packages/lookup?repository_url=https://github.com/";
export const ECO_NAME_LOOKUP = "https://packages.ecosyste.ms/api/v1/packages/lookup?name=";
export const ECO_WORKERS = 4;
/** Pages of 100 packages per repository_url lookup. */
export const ECO_PAGES = 10;
// contract v15: repo-name affixes that registries drop
export const NAME_SUFFIX = pyRe(String.raw`([-_.](nodejs|node|js|py|python|rs|rust|go|golang|rb|ruby|php|java|dotnet|net))$`, true);
export const NAME_PREFIX = pyRe(String.raw`^(node|nodejs|py|python|go|golang|rust|ruby)[-_.]`, true);
const GITHUB_OWNER = pyRe(String.raw`^(?:https?://)?(?:www\.)?github\.com/([^/]+)/[^/]+`);

export function normRepoUrl(url: string | null | undefined): string {
  const u = (url || "").replace(STRIP, "").toLowerCase().replace(/\/+$/, "");
  return u.endsWith(".git") ? u.slice(0, -4) : u;
}

export function githubOwner(url: string | null | undefined): string | null {
  return GITHUB_OWNER.exec(normRepoUrl(url))?.[1] ?? null;
}

/**
 * Contract v15: registry names a repo may publish under besides what ecosyste.ms links to it:
 * the repo name and the name without a language affix (-nodejs, -js, py-, …), lowercase.
 */
export function packageNames(repo: string): string[] {
  const name = repo.slice(repo.indexOf("/") + 1).toLowerCase();
  const out = [name];
  const noSuffix = name.replace(NAME_SUFFIX, "");
  for (const n of [noSuffix, name.replace(NAME_PREFIX, ""), noSuffix.replace(NAME_PREFIX, "")]) {
    if ([...n].length >= 3 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * [dependent packages, dependent repos]: max dependent_packages_count and max
 * dependent_repos_count over the repo's packages; [null, null] when it has none. The repo's
 * packages: those from the repository_url lookup whose repository_url is this repo, plus
 * (contract v15) those from the name lookups whose repository_url is a GitHub repo of the
 * same owner.
 */
export function packageDependents(
  repo: string,
  byUrl: unknown,
  byName: readonly unknown[] = [],
): [number | null, number | null] {
  const want = normRepoUrl("https://github.com/" + repo);
  const owner = repo.slice(0, repo.indexOf("/")).toLowerCase();
  const pkgs = (Array.isArray(byUrl) ? byUrl : []).filter(
    (p): p is Dict => isDict(p) && normRepoUrl(p.repository_url as string | null) === want,
  );
  for (const found of byName) {
    for (const p of Array.isArray(found) ? found : []) {
      if (isDict(p) && githubOwner(p.repository_url as string | null) === owner) pkgs.push(p);
    }
  }
  if (!pkgs.length) return [null, null];
  return [
    Math.max(...pkgs.map((p) => (p.dependent_packages_count as number) || 0)),
    Math.max(...pkgs.map((p) => (p.dependent_repos_count as number) || 0)),
  ];
}

// ---------------------------------------------------------------- star history (contract v15)

export const STAR_API_VERSION = "2026-03-10";
/** The endpoint's cap: 100 pages of 30 weeks. */
export const STAR_PAGES = 100;
/** Owned/led repos by stars that get a star history, plus every one ≥ STAR_BIG. */
export const STAR_TOP = 10;
export const STAR_BIG = 1000;
export const STAR_MIN = 50;
export const STAR_CAP = 25;

export interface StarCandidateRepo {
  name: string;
  is_fork?: boolean | null;
  stars?: number | null;
  owned?: boolean | null;
  user_rank?: number | null;
  repo_total_commits?: number | null;
  user_commits?: number | null;
}

/**
 * Output repo records that get `star_history`: non-fork repos the user owns or leads
 * (user_rank 1, or ≥ 50% of the default branch's commits) with ≥ STAR_MIN stars: the STAR_TOP
 * with the most stars plus every one with ≥ STAR_BIG, ≤ STAR_CAP.
 */
export function starHistoryCandidates(repos: readonly StarCandidateRepo[]): string[] {
  const c = repos
    .filter((r) => {
      const total = r.repo_total_commits;
      const led = r.owned || r.user_rank === 1 || (total && (r.user_commits || 0) * 2 >= total);
      return !r.is_fork && (r.stars || 0) >= STAR_MIN && Boolean(led);
    })
    .sort((a, b) => cmpKeys([-a.stars!, a.name], [-b.stars!, b.name]));
  return [...c.slice(0, STAR_TOP), ...c.slice(STAR_TOP).filter((r) => r.stars! >= STAR_BIG)]
    .slice(0, STAR_CAP)
    .map((r) => r.name);
}

export function starHistoryNote(n: number): string {
  return (
    `star_history (v15): weekly star gains from GET /repos/{r}/stargazers/history (API 2026-03-10) for ` +
    `${n} owned/led non-fork repos (top ${STAR_TOP} by stars ≥ ${STAR_MIN} plus all ≥ ${STAR_BIG}, ≤ ${STAR_CAP}); ` +
    "[date of the Sunday week start, gain], zero weeks omitted; for rule F only, never scored"
  );
}

// ---------------------------------------------------------------- maintainer months (contract v11)

export const CH_URL = "https://play.clickhouse.com/?user=play";
/** Repos with a verified role (by maintainer months) added to the candidates. */
export const MAINT_REPOS = 15;
/** Of those, repos that always get /contributors, issue authors and dependents. */
export const MAINT_SIGNAL_REPOS = 10;
/** Maintainer events in a month that make it a maintainer month. */
export const MAINT_MONTH_MIN = 3;
export const ROLE_RANK: Record<string, number> = { OWNER: 3, MEMBER: 2, COLLABORATOR: 1 };
/** Maintainer event families. */
export const MAINT_TYPES = ["reviews", "comments", "merged", "closes"] as const;

export function maintMonths(months: Record<string, number>): number {
  return Object.values(months).filter((c) => c >= MAINT_MONTH_MIN).length;
}

// ---- contract v15: GH Archive gap months, filled from the GitHub API
/** A month whose daily event rate is below this share of the trailing normal is a gap. */
export const GAP_RATIO = 0.5;
/** Trailing months (non-gap, non-zero) whose median rate is the normal. */
export const GAP_TRAIL = 12;
/** Only gap months within this many months before collection are filled. */
export const GAP_WINDOW = 24;
/** Verified-role repos per user whose gap months are filled. */
export const GAP_REPOS = 15;
/** Closed issues/PRs read per repo-month; above it only those involving the user. */
export const GAP_SAMPLE = 100;
/** Repo-months per closed-item search query. */
export const GAP_BATCH = 4;
/** Pages of 100 of the user's issue comments (newest updated first). */
export const GAP_COMMENT_PAGES = 30;

/** "YYYY-MM" plus k months. */
export function monthAdd(m: string, k: number): string {
  const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + k;
  const y = Math.floor(t / 12);
  return `${y}-${String(t - y * 12 + 1).padStart(2, "0")}`;
}

/**
 * Months whose rate is below GAP_RATIO × the median of the up to GAP_TRAIL previous non-gap,
 * non-zero months (≥ 6 needed).
 */
export function gapSeries(rate: Record<string, number>): string[] {
  const keys = Object.keys(rate).sort(cmpStr);
  const gaps: string[] = [];
  keys.forEach((k, i) => {
    const prev = keys
      .slice(0, i)
      .filter((x) => !gaps.includes(x) && rate[x] > 0)
      .map((x) => rate[x])
      .slice(-GAP_TRAIL);
    if (prev.length >= 6 && rate[k] < GAP_RATIO * [...prev].sort((a, b) => a - b)[prev.length >> 1]) gaps.push(k);
  });
  return gaps;
}
