import { NextRequest } from "next/server";
import { z } from "zod";
import { commentClientIp } from "@/lib/comments";
import { EMPLOYMENT_TYPES } from "@/lib/jobs";
import { checkTalentReportRateLimit, rateLimitHeaders } from "@/lib/redis";
import { llmCompleter } from "@/lib/talent-match/extract";
import { REPORT_INSTANCE_RETENTION, coreDb, jsonNoStore, presentReport, presentSummary, reportWorkflow, sessionUser, signInRequired, unavailable } from "@/lib/talent-match/http";
import {
  candidateInputHash,
  extractForReport,
  failReport,
  failureCode,
  isFinalFailure,
  jobsRevision,
  loadResumeText,
  talentLlmConfigs,
  type CandidateParams,
} from "@/lib/talent-match/pipeline";
import { admitReport, parseTokenBudget } from "@/lib/talent-match/quota";
import { MAX_UPLOAD_CHARS, cleanUploadedText } from "@/lib/talent-match/redact";
import { MATCH_VERSION } from "@/lib/talent-match/score";
import { findDoneReport, insertQueuedReport, latestReport, listOwnReports, monthFreeTokens, quotaCounts } from "@/lib/talent-match/store";
import { verifyTurnstile } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("resume"), id: z.string().min(1).max(100) }),
    z.object({ kind: z.literal("profile") }),
    // Text the browser pulled out of a PDF (the file itself is never uploaded).
    z.object({ kind: z.literal("pdf"), text: z.string().min(1).max(MAX_UPLOAD_CHARS * 2) }),
  ]),
  preferences: z.object({
    location: z.string().trim().max(200),
    remote: z.boolean(),
    employment: z.array(z.enum(EMPLOYMENT_TYPES)).max(EMPLOYMENT_TYPES.length),
  }),
  turnstileToken: z.string().max(4096).nullable().optional(),
});

/** Below this, a "PDF" is a scan or an image: there is nothing to extract. */
const MIN_PDF_CHARS = 100;

const REJECTIONS = {
  in_flight: 409,
  quota_exhausted: 429,
  budget_exhausted: 503,
} as const;

/**
 * The caller's latest report (so the page can resume one in progress), or
 * null, plus their report history (newest first) as summaries.
 */
export async function GET() {
  const user = await sessionUser();
  if (!user) return signInRequired();
  const db = coreDb();
  if (!db) return unavailable();
  const [report, history] = await Promise.all([latestReport(db, user.githubId), listOwnReports(db, user.githubId)]);
  const now = Date.now();
  return jsonNoStore({
    latest: report ? presentReport(report, now) : null,
    history: history.map((summary) => presentSummary(summary, now)),
  });
}

/**
 * Start a candidate report from a saved résumé or uploaded PDF text plus the
 * account's GitHub evidence. Identical input under the current rules and job
 * board returns the finished report instead of spending quota. 202 with the
 * report id; the client polls GET /api/talent-match/reports/:id.
 *
 * PDF text is extracted (LLM #1) inside this request, so the raw text is
 * never stored: only extracted facts reach the Workflow. An unreadable
 * upload fails here, immediately, and uses no quota.
 */
export async function POST(request: NextRequest) {
  const user = await sessionUser();
  if (!user) return signInRequired();

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return jsonNoStore({ error: "invalid_body" }, { status: 400 });
  }
  if (!(await verifyTurnstile(body.turnstileToken ?? null, commentClientIp(request.headers)))) {
    return jsonNoStore({ error: "turnstile_failed" }, { status: 403 });
  }
  const limit = await checkTalentReportRateLimit(user.githubId);
  if (!limit.success) {
    return jsonNoStore({ error: limit.unavailable ? "rate_limit_unavailable" : "rate_limited" }, {
      status: limit.unavailable ? 503 : 429,
      headers: rateLimitHeaders(limit),
    });
  }

  const db = coreDb();
  const workflow = reportWorkflow();
  if (!db || !workflow) return unavailable();

  const now = Date.now();
  const upload = body.source.kind === "pdf";
  const resumeText = body.source.kind === "pdf"
    ? cleanUploadedText(body.source.text)
    : await loadResumeText(db, user.githubId, body.source);
  if (upload && (resumeText ?? "").length < MIN_PDF_CHARS) return jsonNoStore({ error: "pdf_unreadable" }, { status: 400 });
  if (!resumeText) return jsonNoStore({ error: "resume_missing" }, { status: 400 });
  const preferences = { ...body.preferences, employment: [...new Set(body.preferences.employment)] };
  const inputHash = candidateInputHash({ login: user.login, resumeText, preferences, jobsRevision: await jobsRevision(db) });

  const reused = await findDoneReport(db, user.githubId, inputHash, MATCH_VERSION);
  if (reused) return jsonNoStore({ id: reused, status: "done", reused: true });

  const [counts, tokens] = await Promise.all([quotaCounts(db, user.githubId, now), monthFreeTokens(db, now)]);
  const admission = admitReport({
    ...counts,
    byoKey: false,
    monthTokens: tokens,
    monthTokenBudget: parseTokenBudget(process.env.TALENT_MONTHLY_TOKEN_BUDGET),
  });
  if (!admission.ok) return jsonNoStore({ error: admission.reason }, { status: REJECTIONS[admission.reason] });

  const id = crypto.randomUUID();
  const queued = await insertQueuedReport(db, {
    id, githubId: user.githubId, kind: "candidate", inputHash, byoKey: false, matchVersion: MATCH_VERSION, now,
  });
  if (!queued) return jsonNoStore({ error: "in_flight" }, { status: 409 });

  let source: CandidateParams["source"];
  if (body.source.kind === "pdf") {
    // The queued row already holds the one-in-flight slot during this call.
    try {
      const { extracted, unknownSkills } = await extractForReport(db, llmCompleter(talentLlmConfigs()), id, resumeText, Date.now());
      source = { kind: "extracted", profile: extracted, unknownSkills };
    } catch (error) {
      const code = isFinalFailure(error) ? failureCode(error) : "generation_failed";
      if (code === "generation_failed") console.error("talent_upload_extract_failed", error instanceof Error ? error.message : error);
      await failReport(db, id, code, Date.now());
      return jsonNoStore({ error: code }, { status: code === "model_output_invalid" ? 422 : 503 });
    }
  } else {
    source = body.source;
  }

  try {
    await workflow.create({
      id,
      params: { reportId: id, githubId: user.githubId, login: user.login, source, preferences, inputHash, createdAt: now },
      retention: REPORT_INSTANCE_RETENTION,
    });
  } catch (error) {
    console.error("talent_report_start_failed", error instanceof Error ? error.message : error);
    await failReport(db, id, "start_failed", Date.now());
    return unavailable();
  }
  return jsonNoStore({ id, status: "queued" }, { status: 202 });
}
