/**
 * Slop detector (rubric v3 rule A; port of devscore src/slop.zig) from
 * contract-v12 `ext_prs`.
 *
 * Spraying is judged on other people's projects: repos where the user merged
 * their own PR at least twice (write access: employer, own org) are left out.
 * Over rolling 12-month windows ending at each PR, the window with the most
 * rejections (capped at 2·accepted + 20) is scored:
 *   1 rejected: closed by someone else, or withdrawn with nothing of theirs
 *     merged in that repo within 30 days; ≥ rej_min and ≥ rej_ratio × independently merged
 *   2 templated titles: ≥ templ_min and ≥ templ_share of the window
 *   3 duplicates: same normalized title in the same repo within 14 days
 *   4 shotgun: distinct repos in the busiest 7 days ≥ week_repos
 *   5 oversized: PRs of ≥ 5000 changed lines or ≥ 50 files
 * Slop = signal 1 and at least `others` of 2-5.
 */
import type { Developer, ExtPr } from "../model";
import { asciiLower, eqlIgnoreCase, parseUint, utf8Bytes } from "./ascii";

export interface Params {
  window_days: number;
  rej_min: number;
  rej_ratio: number;
  templ_min: number;
  templ_share: number;
  dup_min: number;
  week_repos: number;
  over_lines: number;
  over_files: number;
  over_min: number;
  others: number;
}

export const defaultParams: Readonly<Params> = Object.freeze({
  window_days: 365,
  rej_min: 20,
  rej_ratio: 0.8,
  templ_min: 5,
  templ_share: 0.15,
  dup_min: 3,
  week_repos: 8,
  over_lines: 5000,
  over_files: 50,
  over_min: 2,
  others: 2,
});

export interface Features {
  n: number;
  merged_ind: number;
  rejected: number;
  templ: number;
  dup: number;
  repos_week: number;
  oversized: number;
}

const DAY = 86400;

/** Seconds since the epoch of "YYYY-MM-DDTHH:MM:SSZ"; 0 when malformed. */
export function epoch(s: string): number {
  if (s.length < 19) return 0;
  const y = parseUint(s.slice(0, 4), 65535);
  const mo = parseUint(s.slice(5, 7), 255);
  const d = parseUint(s.slice(8, 10), 255);
  const h = parseUint(s.slice(11, 13), 255);
  const mi = parseUint(s.slice(14, 16), 255);
  const se = parseUint(s.slice(17, 19), 255);
  if (y === null || mo === null || d === null || h === null || mi === null || se === null) return 0;
  if (mo < 1 || mo > 12 || d < 1) return 0;
  // days from civil (Howard Hinnant)
  const yy = y - (mo <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (mo + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return days * 86400 + h * 3600 + mi * 60 + se;
}

/**
 * Title patterns reviewers read as templated or spam: "fix: <copied issue
 * title>" (long), "Fixes #N", "Part k/n", "Add comprehensive ...", bounty
 * tags, and contact/advert text. Works on UTF-8 bytes like the Zig original.
 */
export function templated(title: string): boolean {
  // lowercased UTF-8 bytes: lengths count bytes as in Zig; only ASCII letters fold
  const t = asciiLower(utf8Bytes(title.replace(/^[ \t]+|[ \t]+$/g, "")));
  const isDigit = (i: number) => i < t.length && t[i] >= "0" && t[i] <= "9";
  if (t.startsWith("fix")) {
    let i = 3;
    if (i < t.length && t[i] === "(") {
      while (i < t.length && t[i] !== ")") i += 1;
      i += 1;
    }
    if (i < t.length && t[i] === ":" && t.length - i - 1 >= 40) return true;
  }
  if (t.startsWith("add comprehensive")) return true;
  if (t.startsWith("bounty") || t.startsWith("[bounty")) return true;
  if (["telegram", "whatsapp", "wechat"].some((w) => t.includes(w))) return true;
  // "fixes #N" / "fix #N"
  for (let pos = t.indexOf("fix"); pos >= 0; pos = t.indexOf("fix", pos + 3)) {
    let j = pos + 3;
    if (t.startsWith("es", j)) j += 2;
    while (j < t.length && t[j] === " ") j += 1;
    if (t[j] === "#" && isDigit(j + 1)) return true;
  }
  // "part k/n"
  for (let pos = t.indexOf("part "); pos >= 0; pos = t.indexOf("part ", pos + 5)) {
    let j = pos + 5;
    const d0 = j;
    while (isDigit(j)) j += 1;
    if (j === d0) continue;
    while (j < t.length && t[j] === " ") j += 1;
    if (t[j] === "/") return true;
  }
  return false;
}

/** Titles equal up to punctuation and case: ASCII alphanumerics only (non-ASCII is skipped, as in Zig). */
function normEql(a: string, b: string): boolean {
  return asciiLower(a).replace(/[^a-z0-9]/g, "") === asciiLower(b).replace(/[^a-z0-9]/g, "");
}

/** One PR on someone else's project, with the window-independent facts computed once. */
interface Pr {
  at: number;
  repo: string;
  merged_ind: boolean;
  rejected: boolean;
  templated: boolean;
  duplicate: boolean;
  oversized: boolean;
}

/**
 * Rejected: closed by someone else (a verdict), or withdrawn by the author with
 * nothing of theirs merged in that repo within 30 days (a superseded draft is iteration).
 */
function isRejected(x: ExtPr, at: number, prs: ExtPr[], login: string): boolean {
  if (x.state !== "CLOSED") return false;
  if (!(x.closed_by !== null && eqlIgnoreCase(x.closed_by, login))) return true;
  for (const m of prs) {
    if (m.state !== "MERGED" || !eqlIgnoreCase(m.repo, x.repo)) continue;
    const dt = epoch(m.created_at) - at;
    if (dt >= 0 && dt <= 30 * DAY) return false;
  }
  return true;
}

/** Same title (up to punctuation and case) in the same repo within 14 days before `x`. */
function isDuplicate(x: ExtPr, at: number, prs: ExtPr[]): boolean {
  for (const q of prs) {
    const dt = at - epoch(q.created_at);
    if (dt <= 0 || dt > 14 * DAY) continue;
    if (eqlIgnoreCase(q.repo, x.repo) && normEql(q.title, x.title)) return true;
  }
  return false;
}

/** PRs to other people's projects, oldest first (stable). Team repos (≥ 2 self-merges) are left out. */
function outsidePrs(all: ExtPr[], login: string, p: Params): Pr[] {
  const selfMerges = new Map<string, number>();
  for (const x of all) {
    if (x.merged_by !== null && eqlIgnoreCase(x.merged_by, login)) selfMerges.set(x.repo, (selfMerges.get(x.repo) ?? 0) + 1);
  }
  const outside = all.filter((x) => (selfMerges.get(x.repo) ?? 0) < 2);
  const prs = outside.map((x): Pr => {
    const at = epoch(x.created_at);
    return {
      at,
      repo: x.repo,
      merged_ind: x.state === "MERGED" && !(x.merged_by !== null && eqlIgnoreCase(x.merged_by, login)),
      rejected: isRejected(x, at, outside, login),
      templated: templated(x.title),
      duplicate: isDuplicate(x, at, outside),
      oversized: x.additions + x.deletions >= p.over_lines || x.changed_files >= p.over_files,
    };
  });
  prs.sort((a, b) => a.at - b.at);
  return prs;
}

/** Most distinct repos in any 7 days starting at a PR of the window. */
function busiestWeek(w: Pr[]): number {
  let best = 0;
  for (let i = 0; i < w.length; i++) {
    let repos = 0;
    for (let k = i; k < w.length; k++) {
      if (w[k].at - w[i].at >= 7 * DAY) break;
      let seen = false;
      for (let r = i; r < k; r++) {
        if (eqlIgnoreCase(w[r].repo, w[k].repo)) {
          seen = true;
          break;
        }
      }
      if (!seen) repos += 1;
    }
    best = Math.max(best, repos);
  }
  return best;
}

/**
 * Worst 12-month window of the user's PRs to other people's projects: the most
 * rejections, capped at 2·accepted + 20; ties go to more rejections net of
 * acceptances. null without `ext_prs`.
 */
export function features(d: Developer, p: Params = defaultParams): Features | null {
  if (d.ext_prs === null) return null;
  const prs = outsidePrs(d.ext_prs, d.login, p);
  let best: Features = { n: 0, merged_ind: 0, rejected: 0, templ: 0, dup: 0, repos_week: 0, oversized: 0 };
  let bestKey: [number, number] = [-1, 0];
  let lo = 0;
  for (let hi = 0; hi < prs.length; hi++) {
    const end = prs[hi];
    // window (end − window_days, end]; PRs sharing `end` are all included
    if (hi + 1 < prs.length && prs[hi + 1].at === end.at) continue;
    while (prs[lo].at <= end.at - p.window_days * DAY) lo += 1;
    const w = prs.slice(lo, hi + 1);
    const count = (f: (x: Pr) => boolean) => w.filter(f).length;
    const f: Features = {
      n: w.length,
      merged_ind: count((x) => x.merged_ind),
      rejected: count((x) => x.rejected),
      templ: count((x) => x.templated),
      dup: count((x) => x.duplicate),
      repos_week: busiestWeek(w),
      oversized: count((x) => x.oversized),
    };
    const key: [number, number] = [f.rejected > 0 ? Math.min(f.rejected, 2 * f.merged_ind + 20) : 0, f.rejected - f.merged_ind];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = f;
      bestKey = key;
    }
  }
  return best;
}

/** Rule A verdict; null without `ext_prs` (no data, no verdict). */
export function detect(d: Developer, p: Params = defaultParams): boolean | null {
  const f = features(d, p);
  if (f === null) return null;
  const n = Math.max(1, f.n);
  const rejected = f.rejected >= p.rej_min && f.rejected >= p.rej_ratio * f.merged_ind;
  const others = [
    f.templ >= p.templ_min && f.templ / n >= p.templ_share,
    f.dup >= p.dup_min,
    f.repos_week >= p.week_repos,
    f.oversized >= p.over_min,
  ];
  return rejected && others.filter(Boolean).length >= p.others;
}

/**
 * Whether `closed_by` can change `detect`: only signal 1 (rejections) reads it,
 * and a window's rejections never exceed the CLOSED PRs, so with fewer than
 * rej_min CLOSED PRs the verdict is false whatever `closed_by` says. The
 * collector fetches closers only when this holds (null elsewhere).
 */
export function slopNeedsClosers(prs: readonly Pick<ExtPr, "state">[], p: Params = defaultParams): boolean {
  return prs.filter((x) => x.state === "CLOSED").length >= p.rej_min;
}
