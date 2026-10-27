/**
 * Deterministic checks for roast v13 copy: every number, repository and
 * per-repository star count the model writes is looked up in the payload the
 * model was given. The editor step receives these issues; the final pass drops
 * sentences that still cite facts absent from the data.
 */
import { V13_CLICHE_PHRASES, V13_CLICHE_PHRASES_EN } from "./voice";

export interface V13Copy {
  title: string;
  roast_line: { zh: string; en: string };
  tags: { zh: string[]; en: string[] };
  verdict: string;
  findings: { headline: string; text: string }[];
  dimensions: Record<string, string>;
  risk: string;
  advice: string[];
}

export interface V13Issue {
  kind: "number" | "repo" | "repo_stars" | "cliche" | "schema" | "language";
  field: string;
  detail: string;
}

export interface FactIndex {
  numbers: number[];
  repos: Map<string, number | null>;
  haystack: string;
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

/** Build the lookup index from the exact payload object sent to the models. */
export function buildFactIndex(payload: unknown): FactIndex {
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
  return { numbers: [...set], repos, haystack: JSON.stringify(payload).toLowerCase() };
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

export function validateCopy(index: FactIndex, copy: V13Copy, lang: "zh" | "en"): V13Issue[] {
  const issues: V13Issue[] = [];
  if (!copy.roast_line.zh) issues.push({ kind: "schema", field: "roast_line.zh", detail: "missing" });
  if (!copy.roast_line.en) issues.push({ kind: "schema", field: "roast_line.en", detail: "missing" });
  if (/[㐀-鿿]/.test(copy.roast_line.en)) {
    issues.push({ kind: "language", field: "roast_line.en", detail: "English roast line contains Chinese" });
  }
  if (copy.findings.length < 2) issues.push({ kind: "schema", field: "findings", detail: "need 3 findings" });
  for (const { field, text } of copyFields(copy)) {
    issues.push(...checkText(index, field, text), ...checkCliches(field, text, lang));
  }
  return issues;
}

/** Remove sentences that still cite a repo/number/star count absent from the
 * data after the editor pass. Returns the cleaned copy and what was dropped. */
export function dropUnverifiedSentences(
  index: FactIndex,
  copy: V13Copy,
): { copy: V13Copy; dropped: string[] } {
  const dropped: string[] = [];
  const clean = (field: string, text: string): string => {
    if (!text) return text;
    const parts = text.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [text];
    const kept = parts.filter((s) => {
      const bad = checkText(index, field, s).some((i) => i.kind !== "cliche");
      if (bad) dropped.push(`${field}: ${s.trim()}`);
      return !bad;
    });
    return kept.join("").trim();
  };
  const next: V13Copy = {
    ...copy,
    verdict: clean("verdict", copy.verdict),
    risk: clean("risk", copy.risk),
    findings: copy.findings
      .map((f, i) => ({ headline: f.headline, text: clean(`findings[${i}].text`, f.text) }))
      .filter((f) => f.text),
    dimensions: Object.fromEntries(
      Object.entries(copy.dimensions).map(([k, v]) => [k, clean(`dimensions.${k}`, v)]),
    ),
    advice: copy.advice.map((a, i) => clean(`advice[${i}]`, a)).filter(Boolean),
  };
  return { copy: next, dropped };
}
