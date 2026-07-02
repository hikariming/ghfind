/**
 * Omnibox intent parser — a pure, dependency-light rule engine that turns raw
 * homepage input into a routed intent. Mirrors the side-effect-free style of
 * `facets.ts` / `score.ts` so it's trivially unit-tested and shared between the
 * homepage input and (via `omniboxRoute`) the router.
 *
 * Priority (first match wins), from the design doc:
 *   P0  pk        — ` vs `/` pk `/`大战`/`比比` between two valid handles → /vs/a/b
 *   P0′ pk-half   — separator present, only the left handle valid (UI half-state)
 *   P1  language  — explicit `lang:` / `语言:` prefix → /developers/language/X
 *   P2  org       — explicit `org:` prefix → /developers/org/x
 *   P3  repo      — `owner/name` shape → /developers/repo/owner/name
 *   P5  user      — a bare valid handle → in-place roast (Enter default)
 *   P6  freetext  — anything else → suggestion-only, no navigation
 *
 * Bare language/company words (`rust`, `字节`) intentionally resolve to `user`
 * on Enter to preserve muscle memory — they only surface as *suggestions* (see
 * {@link omniboxSuggestions}), never hijacking a valid username on submit.
 */
import { normalizeUsername } from "./username";

export type OmniIntent =
  | { kind: "pk"; a: string; b: string }
  | { kind: "pk-half"; a: string }
  | { kind: "language"; value: string }
  | { kind: "org"; value: string }
  | { kind: "repo"; owner: string; name: string }
  | { kind: "user"; username: string }
  | { kind: "freetext"; query: string };

export function shouldAutoLockPkIntent(
  intent: OmniIntent,
  suppressHalfLock: boolean,
): intent is Extract<OmniIntent, { kind: "pk" | "pk-half" }> {
  return intent.kind === "pk" || (intent.kind === "pk-half" && !suppressHalfLock);
}

/** Language alias → canonical GitHub Linguist name (matches stored facet value). */
export const LANGUAGE_ALIASES: Record<string, string> = {
  rust: "Rust",
  go: "Go",
  golang: "Go",
  python: "Python",
  py: "Python",
  js: "JavaScript",
  javascript: "JavaScript",
  node: "JavaScript",
  nodejs: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  java: "Java",
  "c++": "C++",
  cpp: "C++",
  c: "C",
  "c#": "C#",
  csharp: "C#",
  ruby: "Ruby",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  ios: "Swift",
  kotlin: "Kotlin",
  安卓: "Kotlin",
  android: "Kotlin",
  scala: "Scala",
  dart: "Dart",
  flutter: "Dart",
  elixir: "Elixir",
  haskell: "Haskell",
  lua: "Lua",
  zig: "Zig",
  ocaml: "OCaml",
  solidity: "Solidity",
  shell: "Shell",
  bash: "Shell",
  html: "HTML",
  css: "CSS",
  vue: "Vue",
  svelte: "Svelte",
};

/**
 * Company / org alias → canonical GitHub org login. Best-effort: the value must
 * match the stored `facet_value` casing to hit a populated bucket, so logins use
 * their canonical casing (e.g. `Tencent`, `NVIDIA`). Tune as data reveals gaps.
 */
export const ORG_ALIASES: Record<string, string> = {
  字节: "bytedance",
  字节跳动: "bytedance",
  抖音: "bytedance",
  bytedance: "bytedance",
  阿里: "alibaba",
  阿里巴巴: "alibaba",
  alibaba: "alibaba",
  腾讯: "Tencent",
  tencent: "Tencent",
  百度: "baidu",
  baidu: "baidu",
  美团: "meituan",
  meituan: "meituan",
  谷歌: "google",
  google: "google",
  微软: "microsoft",
  microsoft: "microsoft",
  苹果: "apple",
  apple: "apple",
  脸书: "facebook",
  facebook: "facebook",
  meta: "facebook",
  亚马逊: "amazon",
  amazon: "amazon",
  英伟达: "NVIDIA",
  nvidia: "NVIDIA",
  openai: "openai",
  抱抱脸: "huggingface",
  huggingface: "huggingface",
  hf: "huggingface",
  vercel: "vercel",
  pytorch: "pytorch",
  apache: "apache",
  k8s: "kubernetes",
  kubernetes: "kubernetes",
};

/** Repo name after the owner: letters/digits + `.`/`_`/`-`, 1-100 chars. */
const REPO_NAME_RE = /^[a-zA-Z0-9._-]{1,100}$/;

/**
 * Locate the first PK separator and split into [left, right].
 * Latin separators (`vs`/`pk`) require surrounding spaces so `vscode`/`pkg`
 * aren't split; CJK separators (`大战`…) don't (ASCII handles can't contain them).
 */
function findPkSplit(s: string): [string, string] | null {
  // Full separator with content on both sides ("a vs b", "a大战b").
  const full = s.match(/\s+(?:vs|pk)\s+|\s*(?:大战|大戰|比比|对决|對決|对线|對線)\s*/i);
  if (full && full.index !== undefined) {
    return [s.slice(0, full.index), s.slice(full.index + full[0].length)];
  }
  // Dangling separator → half-state ("torvalds vs", "nihui大战").
  const half = s.match(/\s+(?:vs|pk)\s*$/i);
  if (half && half.index !== undefined) return [s.slice(0, half.index), ""];
  return null;
}

/** Dictionary-ordered, lowercased pair — the canonical /vs slug (page redirects
 *  /vs/b/a → /vs/a/b, so emitting canonical order here avoids that round-trip). */
function canonicalPair(a: string, b: string): { a: string; b: string } {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return { a: x, b: y };
}

/** Look up a bare token against the language/org alias dictionaries. */
export function matchLanguageAlias(input: string): string | null {
  return LANGUAGE_ALIASES[input.trim().toLowerCase()] ?? null;
}
export function matchOrgAlias(input: string): string | null {
  return ORG_ALIASES[input.trim().toLowerCase()] ?? null;
}

/** Parse the primary (Enter) intent for `input`. */
export function parseOmnibox(input: string): OmniIntent {
  const raw = input.trim();
  if (!raw) return { kind: "freetext", query: "" };

  // P0 / P0′ — PK
  const split = findPkSplit(raw);
  if (split) {
    const a = normalizeUsername(split[0]);
    if (a) {
      const b = normalizeUsername(split[1]);
      if (b) return { kind: "pk", ...canonicalPair(a, b) };
      return { kind: "pk-half", a };
    }
    // Left side invalid — not a usable PK; fall through.
  }

  // P1 — explicit language prefix
  const langPrefix = raw.match(/^(?:lang|language|语言|語言)\s*[:：]\s*(.+)$/i);
  if (langPrefix) {
    const v = langPrefix[1].trim();
    return { kind: "language", value: matchLanguageAlias(v) ?? v };
  }

  // P2 — explicit org prefix
  const orgPrefix = raw.match(/^(?:org|organization|组织|公司|機構|机构)\s*[:：]\s*(.+)$/i);
  if (orgPrefix) {
    const v = orgPrefix[1].trim();
    return { kind: "org", value: matchOrgAlias(v) ?? v.toLowerCase() };
  }

  // P3 — repo owner/name (unambiguous: contains a single slash, both parts valid)
  if (raw.includes("/") && !/\s/.test(raw)) {
    const parts = raw.replace(/^@/, "").split("/");
    if (parts.length === 2) {
      const owner = normalizeUsername(parts[0]);
      if (owner && REPO_NAME_RE.test(parts[1])) {
        return { kind: "repo", owner, name: parts[1] };
      }
    }
  }

  // P5 — bare valid handle (default → in-place roast)
  const user = normalizeUsername(raw);
  if (user) return { kind: "user", username: user };

  // P6 — fallback
  return { kind: "freetext", query: raw };
}

/**
 * Map an intent to a locale-agnostic path (the locale prefix is applied by the
 * `@/i18n/navigation` router/Link). Returns `null` for intents that stay on the
 * homepage (`user` → in-place roast; `pk-half` → UI half-state; `freetext`).
 */
export function omniboxRoute(intent: OmniIntent): string | null {
  switch (intent.kind) {
    case "pk":
      return `/vs/${intent.a}/${intent.b}`;
    case "language":
      return `/developers/language/${encodeURIComponent(intent.value)}`;
    case "org":
      return `/developers/org/${encodeURIComponent(intent.value)}`;
    case "repo":
      return `/developers/repo/${encodeURIComponent(intent.owner)}/${encodeURIComponent(intent.name)}`;
    default:
      return null;
  }
}

export interface OmniSuggestion {
  group: "direct" | "pk" | "user" | "discover";
  intent: OmniIntent;
  /** Where activating this row navigates; null keeps it on the homepage (roast). */
  route: string | null;
}

/**
 * Build the dropdown suggestion rows for `input`, grouped for the panel. The
 * component resolves display strings (i18n) from `intent`. The primary parsed
 * intent leads (直达/对线); language/company aliases surface under 发现 even when
 * the bare word also parses as a username.
 */
export function omniboxSuggestions(input: string): OmniSuggestion[] {
  const raw = input.trim();
  if (!raw) return [];
  const primary = parseOmnibox(raw);
  const out: OmniSuggestion[] = [];

  // 直达 — the primary Enter action (skip pure freetext, which has no target).
  if (primary.kind !== "freetext") {
    const group: OmniSuggestion["group"] =
      primary.kind === "pk" || primary.kind === "pk-half"
        ? "pk"
        : primary.kind === "user"
          ? "user"
          : "discover";
    out.push({ group: primary.kind === "user" ? "direct" : group, intent: primary, route: omniboxRoute(primary) });
  }

  // 对线 — a valid bare handle always advertises "@x vs …" (PK ad slot).
  if (primary.kind === "user") {
    out.push({ group: "pk", intent: { kind: "pk-half", a: primary.username }, route: null });
  }

  // 发现 — language / company aliases (suggestion-only; never hijack Enter).
  const lang = matchLanguageAlias(raw);
  if (lang) {
    const intent: OmniIntent = { kind: "language", value: lang };
    out.push({ group: "discover", intent, route: omniboxRoute(intent) });
  }
  const org = matchOrgAlias(raw);
  if (org) {
    const intent: OmniIntent = { kind: "org", value: org };
    out.push({ group: "discover", intent, route: omniboxRoute(intent) });
  }

  return out;
}
