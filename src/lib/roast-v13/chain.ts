/**
 * Roast v13 generation chain (strong skill, loose normalization, slotted copy):
 *   1. code turns the scan into weighted fact cards (cards.ts);
 *   2. the writer, driven by the fixed roast-writer skill (skill.ts), fills the
 *      slots and cites the cards each slot rests on;
 *   3. code checks numbers, repos, quotes, salience, repetition, citations and
 *      slot lengths (validate.ts); the editor repairs what code flagged;
 *   4. code fills quote tokens with verbatim source text, drops sentences that
 *      still fail, and renders the report with code-owned scores (render.ts).
 * The completion function is injected so the route can use the operator's
 * provider chain and tests/offline evals can stub it. Any failure throws, and
 * the route falls back to the v12 single call.
 */
import type { ChatMessage } from "../llm";
import type { Lang } from "../lang";
import { buildRoastPayload } from "../prompt";
import type { RoastLine, ScanResult, Tags } from "../types";
import { buildFactCards, cardsForPrompt, v13CoverageFlags, type FactCard } from "./cards";
import { SUBSCORE_MAX } from "../score-presentation";
import { redactV13PayloadForCoverage, slimV13Payload } from "./facts";
import { renderV13Report, V13_DIMENSIONS, hasRiskSignals } from "./render";
import { editorSkill, roastWriterSkill, slotRange } from "./skill";

import { sanitizeRoastTags } from "../roast-tags";
import {
  BAD_QUOTE,
  checkSlots,
  checkTrivia,
  fillCopyQuotes,
  buildFactIndex,
  checkText,
  dropUnverifiedSentences,
  validateCopy,
  fitSlotLengths,
  type V13Copy,
  type V13Issue,
} from "./validate";

/** "angles" is kept for log compatibility; the card chain no longer calls it. */
export type V13Step = "angles" | "writer" | "editor";

export interface V13CompleteOptions {
  temperature: number;
  /** Absolute epoch-ms deadline for this step. */
  deadlineMs: number;
}

export type V13Complete = (
  step: V13Step,
  messages: ChatMessage[],
  opts: V13CompleteOptions,
) => Promise<string>;

export interface V13StepLog {
  step: V13Step;
  ms: number;
  inChars: number;
  outChars: number;
  ok: boolean;
  error?: string;
}

export interface V13Result {
  tags: Tags;
  roastLine: RoastLine;
  report: string;
  copy: V13Copy;
  steps: V13StepLog[];
  cards: FactCard[];
  draftIssues: V13Issue[];
  finalIssues: V13Issue[];
  dropped: string[];
}

export class RoastV13Error extends Error {
  constructor(
    message: string,
    readonly steps: V13StepLog[],
  ) {
    super(message);
  }
}

export interface V13Options {
  /** Absolute epoch-ms deadline for the whole chain. */
  deadlineMs: number;
  /** Per-step budget cap (ms). */
  stepBudgetMs?: number;
  now?: () => number;
}

/** Tolerant JSON object extraction (models sometimes wrap output in fences). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function cleanTags(list: string[], maxLen: number): string[] {
  // Substance only: drop follower-ratio / time-window trivia, cap at 4.
  return sanitizeRoastTags(list, maxLen);
}

function clamp(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join("");
  const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf(". "), cut.lastIndexOf("——"));
  return stop > max * 0.5 ? cut.slice(0, stop + 1).trim() : cut.trim() + "…";
}

const textOf = (v: unknown): string => (typeof v === "string" ? str(v) : str((v as Record<string, unknown> | null)?.text));
const citesOf = (v: unknown): string[] =>
  v && typeof v === "object" && !Array.isArray(v) ? strList((v as Record<string, unknown>).cards) : [];

export function coerceCopy(raw: Record<string, unknown> | null, lang: Lang = "zh"): V13Copy | null {
  if (!raw) return null;
  const rl = (raw.roast_line ?? {}) as Record<string, unknown>;
  const tags = (raw.tags ?? {}) as Record<string, unknown>;
  const dims = (raw.dimensions ?? {}) as Record<string, unknown>;
  const cites: Record<string, string[]> = {};
  const cap = (slot: Parameters<typeof slotRange>[0]) => Math.round(slotRange(slot, lang).max * 1.25);
  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .map((f) => {
          const o = (f ?? {}) as Record<string, unknown>;
          return { headline: str(o.headline), text: str(o.text), cards: strList(o.cards) };
        })
        .filter((f) => f.text)
        .slice(0, 3)
    : [];
  findings.forEach((f, i) => (cites[`findings[${i}]`] = f.cards));
  cites.roast_line = strList(rl.cards);
  cites.verdict = citesOf(raw.verdict);
  const advice = (Array.isArray(raw.advice) ? raw.advice : []).map((a) => ({ text: textOf(a), cards: citesOf(a) })).filter((a) => a.text).slice(0, 4);
  advice.forEach((a, i) => (cites[`advice[${i}]`] = a.cards));
  for (const k of V13_DIMENSIONS) cites[`dimensions.${k}`] = citesOf(dims[k]);
  const copy: V13Copy = {
    title: clamp(str(raw.title), 40),
    roast_line: { zh: clamp(str(rl.zh), 120), en: clamp(str(rl.en), 170) },
    tags: { zh: cleanTags(strList(tags.zh), 6), en: cleanTags(strList(tags.en), 20) },
    verdict: clamp(textOf(raw.verdict), cap("verdict")),
    findings: findings.map((f) => ({ headline: f.headline, text: clamp(f.text, cap("finding")) })),
    dimensions: Object.fromEntries(V13_DIMENSIONS.map((k) => [k, clamp(textOf(dims[k]), cap("dimension"))])),
    risk: textOf(raw.risk),
    advice: advice.map((a) => clamp(a.text, cap("advice"))),
    cites,
  };
  if (!copy.roast_line.zh && !copy.roast_line.en && !copy.findings.length) return null;
  return copy;
}

/** Drop clauses of the one-liner that still cite unverified facts. */
function repairRoastLine(index: ReturnType<typeof buildFactIndex>, field: string, text: string): string {
  const bad = (t: string) =>
    t.includes(BAD_QUOTE) ||
    checkText(index, field, t).length > 0 ||
    checkTrivia(index, field, t).some((i) => i.detail.startsWith("follower") || i.detail.startsWith("a few PRs"));
  if (!bad(text)) return text;
  const clauses = text.split(/(?<=[，,；;。—])/);
  const kept = clauses.filter((c) => !bad(c)).join("").replace(/[，,；;—]+$/, "");
  return [...kept].length >= 12 ? kept : "";
}

export function buildV13UserMessage(
  label: string,
  sections: Record<string, unknown>,
): string {
  return (
    `${label}\n\n` +
    Object.entries(sections)
      .map(([k, v]) => `### ${k}\n\`\`\`json\n${typeof v === "string" ? v : JSON.stringify(v)}\n\`\`\``)
      .join("\n\n")
  );
}

export async function generateRoastV13(
  scan: ScanResult,
  lang: Lang,
  complete: V13Complete,
  opts: V13Options,
): Promise<V13Result> {
  const now = opts.now ?? Date.now;
  const stepBudget = opts.stepBudgetMs ?? 60_000;
  const payload = slimV13Payload(buildRoastPayload(scan, lang));
  const cards = buildFactCards(payload, { username: scan.metrics.username, scan });
  const promptCards = cardsForPrompt(cards);
  const coverage = v13CoverageFlags(scan, payload);
  // Writer/editor only see cards, but the number/repo validator indexes the
  // payload — redact incomplete inventory so invented "全量" counts cannot pass.
  const indexedPayload = redactV13PayloadForCoverage(payload, scan);
  const index = buildFactIndex({ ...indexedPayload, fact_cards: promptCards }, scan);
  const steps: V13StepLog[] = [];
  const dims = Object.fromEntries(
    V13_DIMENSIONS.map((k) => {
      const score = Number(scan.scoring.sub_scores[k] ?? 0);
      const max = SUBSCORE_MAX[k];
      return [k, { score, max, pct_of_max: max ? Math.round((score / max) * 100) : null }];
    }),
  );
  const header = {
    username: scan.metrics.username,
    final_score: scan.scoring.final_score,
    tier: scan.scoring.tier,
    sub_scores: dims,
    has_risk_signals: hasRiskSignals(scan),
    pronoun_usage: scan.metrics.pronouns ? `GitHub 资料填写的代词:${scan.metrics.pronouns}` : "未填写代词:用用户名或\"你\"",
    report_language: lang,
  };
  // Quotes are checked after tokens are filled, so every check sees final text.
  const check = (copy: V13Copy): V13Issue[] => {
    const filled = fillCopyQuotes(copy, cards, lang);
    return [...checkSlots(filled, cards, lang), ...validateCopy(index, filled, lang)];
  };

  const run = async (step: V13Step, messages: ChatMessage[], temperature: number): Promise<string> => {
    const t = now();
    const remaining = opts.deadlineMs - t;
    if (remaining < 5_000) {
      steps.push({ step, ms: 0, inChars: 0, outChars: 0, ok: false, error: "deadline" });
      throw new RoastV13Error(`no budget for ${step}`, steps);
    }
    const inChars = messages.reduce((n, m) => n + m.content.length, 0);
    try {
      const out = await complete(step, messages, {
        temperature,
        deadlineMs: t + Math.min(stepBudget, remaining),
      });
      steps.push({ step, ms: now() - t, inChars, outChars: out.length, ok: true });
      return out;
    } catch (e) {
      steps.push({ step, ms: now() - t, inChars, outChars: 0, ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "error" });
      throw e;
    }
  };

  // 1) Writer, from the fixed skill and the fact cards (one retry when the
  // provider returns an empty or unparseable body).
  const writerMessages: ChatMessage[] = [
    { role: "system", content: roastWriterSkill(lang, coverage.partial ? { partialCoverage: true, reasons: coverage.reasons } : undefined) },
    {
      role: "user",
      content: buildV13UserMessage("按 skill 填满每个槽位。直接输出 JSON 对象,第一个字符必须是 {,不要任何开场白。", { account: header, cards: promptCards }),
    },
  ];
  let draft: V13Copy | null = null;
  for (let attempt = 0; attempt < 2 && !draft; attempt++) {
    draft = coerceCopy(parseJsonObject(await run("writer", writerMessages, 0.85)), lang);
  }
  if (!draft) throw new RoastV13Error("writer returned no usable JSON", steps);
  const draftIssues = check(draft);

  // 2) Editor repairs what code flagged and polishes. Falls back to the draft.
  let edited: V13Copy = draft;
  const editorMessages: ChatMessage[] = [
    { role: "system", content: editorSkill(lang, coverage.partial ? { partialCoverage: true, reasons: coverage.reasons } : undefined) },
    {
      role: "user",
      content: buildV13UserMessage("终审这份草稿。直接输出最终 JSON 对象,第一个字符必须是 {,不要任何开场白。", {
        account: header,
        validator_issues: draftIssues.length ? draftIssues : "none",
        draft: { ...draft, cites: undefined, cards_cited: draft.cites },
        cards: promptCards,
      }),
    },
  ];
  // One retry when the editor answers with a preamble instead of JSON.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fixed = coerceCopy(parseJsonObject(await run("editor", editorMessages, 0.3)), lang);
      if (fixed) {
        edited = fixed;
        break;
      }
    } catch (e) {
      if (e instanceof RoastV13Error) throw e;
      break;
    }
  }

  // 3) Code fills quotes with verbatim source text.
  const filled = fillCopyQuotes(edited, cards, lang);

  // 4) Deterministic last line of defence.
  const { copy: verified, dropped } = dropUnverifiedSentences(index, filled);
  verified.roast_line = {
    zh: repairRoastLine(index, "roast_line.zh", verified.roast_line.zh),
    en: /[㐀-鿿]/.test(verified.roast_line.en) ? "" : repairRoastLine(index, "roast_line.en", verified.roast_line.en),
  };
  const draftLine = fillCopyQuotes(draft, cards, lang).roast_line.zh;
  if (!verified.roast_line.zh && draftLine && !draftLine.includes(BAD_QUOTE) && !checkText(index, "roast_line.zh", draftLine).length) {
    verified.roast_line.zh = draftLine;
  }
  if (!verified.roast_line.zh || verified.findings.length === 0 || !verified.verdict) {
    throw new RoastV13Error("copy failed verification", steps);
  }
  const fitted = fitSlotLengths(verified, lang);
  const finalIssues = [...checkSlots(fitted, cards, lang), ...validateCopy(index, fitted, lang)];
  return {
    tags: fitted.tags,
    roastLine: fitted.roast_line,
    report: renderV13Report(scan, lang, fitted),
    copy: fitted,
    steps,
    cards,
    draftIssues,
    finalIssues,
    dropped,
  };
}
