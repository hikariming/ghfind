/**
 * Roast v13 generation chain: angle picker → writer → editor, followed by
 * deterministic fact checks. The completion function is injected so the route
 * can use the operator's provider chain and tests/offline evals can stub it.
 */
import type { ChatMessage } from "../llm";
import type { Lang } from "../lang";
import { buildRoastPayload } from "../prompt";
import type { RoastLine, ScanResult, Tags } from "../types";
import { buildWriterFactCard, slimV13Payload } from "./facts";
import { renderV13Report, V13_DIMENSIONS, hasRiskSignals } from "./render";
import {
  buildFactIndex,
  checkText,
  dropUnverifiedSentences,
  validateCopy,
  type V13Copy,
  type V13Issue,
} from "./validate";
import { ANGLE_SYSTEM, editorSystem, writerSystem } from "./voice";

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
  /** Skip the angle step (saves one call; quality drops). */
  skipAngles?: boolean;
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
  const cleaned = [...new Set(list.map((t) => t.replace(/[#@,，|]/g, "").trim()).filter(Boolean))];
  // Prefer dropping an over-long tag to cutting it mid-word ("少开issu").
  const fitting = cleaned.filter((t) => [...t].length <= maxLen);
  const tags = fitting.length >= 2 ? fitting : cleaned.map((t) => [...t].slice(0, maxLen).join(""));
  return tags.slice(0, 5);
}

function clamp(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join("");
  const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf(". "), cut.lastIndexOf("——"));
  return stop > max * 0.5 ? cut.slice(0, stop + 1).trim() : cut.trim() + "…";
}

export function coerceCopy(raw: Record<string, unknown> | null): V13Copy | null {
  if (!raw) return null;
  const rl = (raw.roast_line ?? {}) as Record<string, unknown>;
  const tags = (raw.tags ?? {}) as Record<string, unknown>;
  const dims = (raw.dimensions ?? {}) as Record<string, unknown>;
  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .map((f) => {
          const o = (f ?? {}) as Record<string, unknown>;
          return { headline: str(o.headline), text: str(o.text) };
        })
        .filter((f) => f.text)
        .slice(0, 3)
    : [];
  const copy: V13Copy = {
    title: clamp(str(raw.title), 40),
    roast_line: { zh: clamp(str(rl.zh), 120), en: clamp(str(rl.en), 170) },
    tags: { zh: cleanTags(strList(tags.zh), 6), en: cleanTags(strList(tags.en), 20) },
    verdict: clamp(str(raw.verdict), 160),
    findings,
    dimensions: Object.fromEntries(V13_DIMENSIONS.map((k) => [k, clamp(str(dims[k]), 90)])),
    risk: str(raw.risk),
    advice: strList(raw.advice).slice(0, 2),
  };
  if (!copy.roast_line.zh && !copy.roast_line.en && !copy.findings.length) return null;
  return copy;
}

/** Drop clauses of the one-liner that still cite unverified facts. */
function repairRoastLine(index: ReturnType<typeof buildFactIndex>, field: string, text: string): string {
  if (!checkText(index, field, text).length) return text;
  const clauses = text.split(/(?<=[，,；;。—])/);
  const kept = clauses.filter((c) => !checkText(index, field, c).length).join("").replace(/[，,；;—]+$/, "");
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
  const factCard = buildWriterFactCard(payload);
  const index = buildFactIndex(payload);
  const steps: V13StepLog[] = [];
  const dims = Object.fromEntries(
    V13_DIMENSIONS.map((k) => [k, scan.scoring.sub_scores[k]]),
  );
  const header = {
    username: scan.metrics.username,
    final_score: scan.scoring.final_score,
    tier: scan.scoring.tier,
    sub_scores: dims,
    has_risk_signals: hasRiskSignals(scan),
    report_language: lang,
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

  // 1) Angle picker. Failure is tolerated: the writer can work from the payload.
  let angles: unknown = null;
  if (!opts.skipAngles) {
    try {
      const out = await run(
        "angles",
        [
          { role: "system", content: ANGLE_SYSTEM },
          { role: "user", content: buildV13UserMessage("挑选角度。", { account: header, data: payload }) },
        ],
        0.4,
      );
      angles = parseJsonObject(out);
    } catch (e) {
      if (e instanceof RoastV13Error) throw e;
      angles = null;
    }
  }

  // 2) Writer (one retry when the provider returns an empty/unparseable body).
  const writerMessages = (): ChatMessage[] => [
      { role: "system", content: writerSystem(lang) },
      {
        role: "user",
        content: buildV13UserMessage("写这份锐评。角度是建议,挑最狠的 3 个写透;数字只能来自 facts。", {
          account: header,
          angles: angles ?? "(angle step unavailable; pick the sharpest facts yourself)",
          facts: factCard,
        }),
      },
  ];
  let writerJson: Record<string, unknown> | null = null;
  let draft: V13Copy | null = null;
  for (let attempt = 0; attempt < 2 && !draft; attempt++) {
    writerJson = parseJsonObject(await run("writer", writerMessages(), 0.9));
    draft = coerceCopy(writerJson);
  }
  const candidates = strList(writerJson?.roast_line_candidates).slice(0, 4);
  if (!draft) throw new RoastV13Error("writer returned no usable JSON", steps);
  const draftIssues = validateCopy(index, draft, lang);

  // 3) Editor. Falls back to the draft when it fails or returns garbage.
  let edited: V13Copy = draft;
  try {
    const out = await run(
      "editor",
      [
        { role: "system", content: editorSystem(lang) },
        {
          role: "user",
          content: buildV13UserMessage("终审这份草稿,输出最终 JSON。", {
            account: header,
            validator_issues: draftIssues.length ? draftIssues : "none",
            draft: candidates.length ? { ...draft, roast_line_candidates: candidates } : draft,
            data: payload,
          }),
        },
      ],
      0.3,
    );
    edited = coerceCopy(parseJsonObject(out)) ?? draft;
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    edited = draft;
  }

  // 4) Deterministic last line of defence.
  const { copy: verified, dropped } = dropUnverifiedSentences(index, edited);
  verified.roast_line = {
    zh: repairRoastLine(index, "roast_line.zh", verified.roast_line.zh),
    en: /[㐀-鿿]/.test(verified.roast_line.en) ? "" : repairRoastLine(index, "roast_line.en", verified.roast_line.en),
  };
  if (!verified.roast_line.zh && draft.roast_line.zh && !checkText(index, "roast_line.zh", draft.roast_line.zh).length) {
    verified.roast_line.zh = draft.roast_line.zh;
  }
  if (!verified.roast_line.zh || verified.findings.length === 0 || !verified.verdict) {
    throw new RoastV13Error("copy failed verification", steps);
  }
  const finalIssues = validateCopy(index, verified, lang);
  return {
    tags: verified.tags,
    roastLine: verified.roast_line,
    report: renderV13Report(scan, lang, verified),
    copy: verified,
    steps,
    draftIssues,
    finalIssues,
    dropped,
  };
}
