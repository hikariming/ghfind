import type { EmploymentType } from "@/lib/jobs";
import { readResumeLibraryFull } from "@/lib/resume";
import { cleanUploadedText } from "./redact";
import type { CandidateReport, Quota, Text } from "./types";

/**
 * Browser calls for the /talent-match page. Every function resolves (never
 * throws) so components only branch on data: failures come back as
 * `{ error }` with the API's error code, or "network" when unreachable.
 */

export type ReportStatus = "queued" | "running" | "done" | "failed";

export interface ReportState {
  id: string;
  status: ReportStatus;
  report: CandidateReport | null;
  error: string | null;
}

export type ResumeSourceOption = { kind: "resume"; id: string; label: string; updatedAt: string } | { kind: "profile"; label: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(path, { credentials: "same-origin", ...init });
    if (res.status === 204) return { ok: true, value: undefined as T };
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: body?.error ?? `http_${res.status}` };
    return { ok: true, value: body as T };
  } catch {
    return { ok: false, error: "network" };
  }
}

export const getQuota = () => call<Quota & { inFlight: boolean }>("/api/talent-match/quota");

/** A past report in the history list; open it with getReport. */
export interface ReportSummary {
  id: string;
  status: ReportStatus;
  error: string | null;
  /** ISO timestamp. */
  createdAt: string;
  headline: Text | null;
  matchCount: number;
  topFit: number | null;
}

/** The latest report (to resume one in flight) and the owner's report history, newest first. */
export const getReports = () => call<{ latest: ReportState | null; history: ReportSummary[] }>("/api/talent-match/reports");

export const getReport = (id: string) => call<ReportState>(`/api/talent-match/reports/${encodeURIComponent(id)}`);

export interface CreateReportInput {
  source: { kind: "resume"; id: string } | { kind: "profile" } | { kind: "pdf"; text: string };
  preferences: { location: string; remote: boolean; employment: EmploymentType[] };
  turnstileToken: string | null;
}

export const createReport = (input: CreateReportInput) =>
  call<{ id: string; status: ReportStatus; reused?: boolean }>("/api/talent-match/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

/** The account's profile state: null before any report has built one. */
export const getTalentProfile = () => call<{ profile: { optedIn: boolean } | null }>("/api/talent-match/profile");

export const setOpenToOpportunities = (optedIn: boolean) =>
  call<{ optedIn: boolean }>("/api/talent-match/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ optedIn }),
  });

export const deleteTalentProfile = () => call<void>("/api/talent-match/profile", { method: "DELETE" });

/** Cloud-saved résumés (newest first) plus the reusable profile, the sources a report can read. */
export async function listResumeSources(): Promise<Result<ResumeSourceOption[]>> {
  const result = await call<{ data: string | null }>("/api/resumes");
  if (!result.ok) return result;
  if (!result.value.data) return { ok: true, value: [] };
  try {
    const library = readResumeLibraryFull(result.value.data);
    const resumes: ResumeSourceOption[] = [...library.resumes]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => ({ kind: "resume", id: r.id, label: r.name || r.basics.name || r.id, updatedAt: r.updatedAt }));
    return { ok: true, value: library.profile ? [...resumes, { kind: "profile", label: "" }] : resumes };
  } catch {
    return { ok: false, error: "resumes_unavailable" };
  }
}

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Same floor as the API: less text than this means a scanned or image-only PDF. */
const MIN_PDF_CHARS = 100;

const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);

/**
 * Checks a picked file before reading it. Some systems report no MIME type
 * for PDFs, so an empty type falls back to the .pdf extension.
 */
export function checkPdfFile(file: { name: string; type: string; size: number }): "pdf_type" | "pdf_too_large" | "pdf_empty" | null {
  if (file.type ? !PDF_TYPES.has(file.type) : !/\.pdf$/i.test(file.name)) return "pdf_type";
  if (file.size === 0) return "pdf_empty";
  if (file.size > MAX_PDF_BYTES) return "pdf_too_large";
  return null;
}

/**
 * Read a PDF's text in the browser (the file is never uploaded), with contact
 * details redacted. pdf.js is loaded only when someone picks a file.
 */
export async function readPdfText(file: File): Promise<Result<{ text: string; pages: number }>> {
  const invalid = checkPdfFile(file);
  if (invalid) return { ok: false, error: invalid };
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    const clean = cleanUploadedText(text);
    if (clean.length < MIN_PDF_CHARS) return { ok: false, error: "pdf_unreadable" };
    return { ok: true, value: { text: clean, pages: totalPages } };
  } catch {
    return { ok: false, error: "pdf_parse_failed" };
  }
}
