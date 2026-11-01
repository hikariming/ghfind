/**
 * Roast tags: substance-only filter + locale pick for display.
 *
 * Tags name what someone builds/maintains, their stack/direction, or
 * maintenance depth. Trivial-stat gotchas (follower ratios, time windows,
 * tiny-PR counts to famous repos) are rejected in code — prompt text alone
 * is not enough. The UI shows one language per locale so zh+en pills do not
 * waste space saying the same thing twice.
 */
import { normLang, type Lang } from "./lang";
import type { Tags } from "./types";

/** Soft cap: fewer, sharper tags beat a wall of pills. */
export const ROAST_TAG_CAP = 4;

/**
 * Patterns that mark a tag as a trivial-stat gotcha. Matched against the
 * whole tag (case-insensitive). Keep this list short and specific — substance
 * tags that happen to mention a number stay.
 */
const TRIVIA_TAG_RE: readonly RegExp[] = [
  // Follower / following ratio ("关注倒挂", "Follows>Fans", "粉丝滤镜" as pure social).
  /关注倒挂|粉丝倒挂|粉关倒挂|关粉倒挂/,
  /follows?\s*[<>]=?\s*fans?/i,
  /fans?\s*[<>]=?\s*follows?/i,
  /followers?\s*[<>]=?\s*following/i,
  /following\s*[<>]=?\s*followers?/i,
  /follow(?:er)?\s*ratio/i,
  /粉丝滤镜|关注滤镜|互关党|互关狂/,
  /fan\s*filter|follower\s*flex/i,
  // Commit / activity time windows.
  /近\d+\s*(天|日|周|月)/,
  /last\s*\d+\s*(day|week|month)/i,
  /commit\s*window|time\s*window/i,
  // Vague "thickness" / depth-as-metric jabs that name no project.
  /^厚度$/,
  /卡在厚度|没有厚度/,
  // Bare role labels are not substance.
  /^(?:协作者|维护者|贡献者|Owner|OWNER|Collaborator|Maintainer|Contributor|Committer)$/i,
  // Open-issue backlog gotchas — many open issues usually mean an active project.
  /Issue\s*堆肥|Issue堆肥|议题堆肥|issue\s*composter/i,
  /Issue\s*积压|议题积压|Issue\s*欠账|issue\s*backlog/i,
  /待清\s*Issue|清\s*Issue|Issue\s*清道夫|issue\s*janitor/i,
  /^Issue\s*\d+/i,
  /\d+\s*个?(?:开放)?Issue/,
];

export function isTriviaTag(tag: string): boolean {
  const t = tag.trim();
  if (!t) return true;
  return TRIVIA_TAG_RE.some((re) => re.test(t));
}

/**
 * Clean, dedupe, drop trivia, and cap a tag list. Over-long tags are dropped
 * (not mid-word sliced) when enough shorter ones remain.
 */
export function sanitizeRoastTags(list: readonly string[], maxLen: number, cap = ROAST_TAG_CAP): string[] {
  const cleaned = [
    ...new Set(
      list
        .map((t) => t.replace(/[#@,，|]/g, "").trim())
        .filter(Boolean)
        .filter((t) => !isTriviaTag(t)),
    ),
  ];
  const fitting = cleaned.filter((t) => [...t].length <= maxLen);
  const tags = fitting.length >= 1 ? fitting : cleaned.map((t) => [...t].slice(0, maxLen).join(""));
  return tags.slice(0, cap);
}

export function sanitizeTagsPair(tags: Tags, cap = ROAST_TAG_CAP): Tags {
  return {
    zh: sanitizeRoastTags(tags.zh ?? [], 6, cap),
    en: sanitizeRoastTags(tags.en ?? [], 20, cap),
  };
}

/**
 * Pick tags for the active UI locale. Prefer the locale's list; fall back to
 * the other language only when the preferred side is empty (legacy rows).
 */
export function tagsForLocale(tags: Tags | null | undefined, locale: unknown, cap = ROAST_TAG_CAP): string[] {
  if (!tags) return [];
  const lang: Lang = normLang(locale);
  const primary = (tags[lang] ?? []).filter((t) => !isTriviaTag(t));
  if (primary.length > 0) return primary.slice(0, cap);
  const fallback = (tags[lang === "zh" ? "en" : "zh"] ?? []).filter((t) => !isTriviaTag(t));
  return fallback.slice(0, cap);
}
