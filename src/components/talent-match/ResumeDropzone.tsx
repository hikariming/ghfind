"use client";

import { useRef, useState, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, FileText, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { MAX_PDF_BYTES, checkPdfFile, readPdfText } from "@/lib/talent-match/client";
import { secondaryButton } from "./parts";

/** Text read from a PDF in this browser; the file itself never leaves it. */
export type PdfResume = { name: string; text: string; pages: number };

type DropState =
  | { kind: "idle" }
  | { kind: "reading"; name: string }
  | { kind: "error"; code: string; size?: number };

const MAX_MB = MAX_PDF_BYTES / 1024 / 1024;

const ERROR_KEYS: Record<string, string> = {
  pdf_type: "type",
  pdf_too_large: "size",
  pdf_empty: "empty",
  multiple: "multiple",
  pdf_unreadable: "unreadable",
  pdf_parse_failed: "parse",
};

/**
 * Drag-and-drop PDF picker for /talent-match. Validates type and size before
 * reading, then shows reading, ready and error states. `value` is owned by the
 * parent so a read résumé survives switching between source options.
 */
export function ResumeDropzone({ value, onChange }: { value: PdfResume | null; onChange: (pdf: PdfResume | null) => void }) {
  const t = useTranslations("talentMatch.drop");
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<DropState>({ kind: "idle" });
  // dragenter/dragleave fire for every child; count them so the highlight doesn't flicker.
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const read = async (file: File) => {
    const invalid = checkPdfFile(file);
    if (invalid) {
      setState({ kind: "error", code: invalid, size: file.size });
      return;
    }
    onChange(null);
    setState({ kind: "reading", name: file.name });
    const result = await readPdfText(file);
    if (result.ok) {
      onChange({ name: file.name, ...result.value });
      setState({ kind: "idle" });
    } else {
      setState({ kind: "error", code: result.error, size: file.size });
    }
  };

  const pick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      setState({ kind: "error", code: "multiple" });
      return;
    }
    void read(files[0]);
  };

  const onDrag = (event: DragEvent, delta: 1 | -1) => {
    event.preventDefault();
    depth.current = Math.max(0, depth.current + delta);
    setDragging(depth.current > 0);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (state.kind !== "reading") pick(event.dataTransfer.files);
  };

  const browse = () => input.current?.click();
  const fileInput = (
    <input
      ref={input}
      id="tm-pdf"
      type="file"
      accept="application/pdf,.pdf"
      aria-label={t("label")}
      className="sr-only"
      onChange={(e) => {
        pick(e.target.files);
        // Allow picking the same file again after an error.
        e.target.value = "";
      }}
    />
  );

  if (value && state.kind !== "reading") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4" aria-live="polite">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-100">{t("readyTitle")}</p>
            <p className="truncate text-xs text-zinc-400">
              <FileText className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
              {value.name} · {t("readyMeta", { pages: value.pages, chars: value.text.length.toLocaleString() })}
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={`${secondaryButton} bg-zinc-950/60`} onClick={browse}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{t("replace")}
            </button>
            <button type="button" className={`${secondaryButton} bg-zinc-950/60`} onClick={() => { onChange(null); setState({ kind: "idle" }); }}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />{t("remove")}
            </button>
          </div>
          {fileInput}
        </div>
        {state.kind === "error" && <DropError code={state.code} size={state.size} />}
        <p className="text-xs text-zinc-500">{t("privacy")}</p>
      </div>
    );
  }

  const reading = state.kind === "reading";
  return (
    <div className="space-y-2">
      <div
        onDragEnter={(e) => onDrag(e, 1)}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => onDrag(e, -1)}
        onDrop={onDrop}
        data-state={reading ? "reading" : dragging ? "dragging" : state.kind}
        aria-busy={reading}
        className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-5 py-8 text-center transition-colors focus-within:border-orange-400/30 ${
          dragging
            ? "border-orange-400/30 bg-orange-500/10"
            : state.kind === "error"
              ? "border-rose-400/40 bg-red-500/[0.04]"
              : "border-white/15 bg-white/[0.02] hover:border-white/20 hover:bg-white/5"
        }`}
      >
        {reading ? (
          <div aria-live="polite" className="flex flex-col items-center">
            <Loader2 className="h-8 w-8 animate-spin text-orange-400" aria-hidden="true" />
            <p className="mt-3 max-w-full truncate text-sm font-semibold text-zinc-100">{t("reading", { name: state.name })}</p>
            <p className="mt-1 text-xs text-zinc-500">{t("readingHint")}</p>
            <div className="mt-4 h-1 w-40 overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-orange-500" />
            </div>
          </div>
        ) : (
          <>
            <span className={`flex h-12 w-12 items-center justify-center rounded-full border ${dragging ? "border-orange-400/30 bg-orange-500/15 text-orange-300" : "border-white/10 bg-white/5 text-zinc-300"}`}>
              <Upload className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-semibold text-zinc-100">{dragging ? t("dragging") : t("title")}</p>
            {!dragging && (
              <>
                <p className="mt-1 text-xs text-zinc-500">{t("or")}</p>
                <button type="button" className={`${secondaryButton} mt-2`} onClick={browse}>
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />{state.kind === "error" ? t("retry") : t("browse")}
                </button>
                <p className="mt-3 text-xs text-zinc-500">{t("rules", { max: MAX_MB })}</p>
              </>
            )}
          </>
        )}
        {fileInput}
      </div>
      {state.kind === "error" && <DropError code={state.code} size={state.size} />}
      <p className="text-xs text-zinc-500">{t("privacy")}</p>
    </div>
  );
}

function DropError({ code, size }: { code: string; size?: number }) {
  const t = useTranslations("talentMatch.drop");
  const key = ERROR_KEYS[code] ?? "parse";
  const message = key === "size" ? t("errors.size", { size: ((size ?? 0) / 1024 / 1024).toFixed(1), max: MAX_MB }) : t(`errors.${key}`);
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-rose-400">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span><span className="font-semibold">{t("errorTitle")}</span> · {message}</span>
    </div>
  );
}
