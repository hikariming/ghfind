"use client";

import { useLocale, useTranslations } from "next-intl";
import { ArrowUpRight, Check, CloudUpload, FilePlus2, FileText, Library, UserRound } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { MAX_PDF_BYTES, type ResumeSourceOption } from "@/lib/talent-match/client";
import { ResumeDropzone, type PdfResume } from "./ResumeDropzone";
import { primaryButton, secondaryButton } from "./parts";

export type SourceMode = "existing" | "upload";

export function sourceKeyOf(source: ResumeSourceOption): string {
  return source.kind === "profile" ? "profile" : `resume:${source.id}`;
}

/**
 * Choose-one résumé input for /talent-match: a résumé already saved on
 * ghfind, or a PDF read in the browser. `sources` is null while loading and
 * "error" when the saved résumés couldn't be read.
 */
export function ResumeSourcePicker({
  mode,
  onMode,
  sources,
  sourceKey,
  onSourceKey,
  pdf,
  onPdf,
}: {
  mode: SourceMode;
  onMode: (mode: SourceMode) => void;
  sources: ResumeSourceOption[] | null | "error";
  sourceKey: string;
  onSourceKey: (key: string) => void;
  pdf: PdfResume | null;
  onPdf: (pdf: PdfResume | null) => void;
}) {
  const t = useTranslations("talentMatch.source");
  const options: [SourceMode, string, string, typeof Library][] = [
    ["existing", t("existingTitle"), t("existingHint"), Library],
    ["upload", t("uploadTitle"), t("uploadHint", { max: MAX_PDF_BYTES / 1024 / 1024 }), CloudUpload],
  ];

  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 flex items-center gap-1.5 text-sm font-medium text-zinc-200">
        <FileText className="h-4 w-4" aria-hidden="true" />{t("legend")}
      </legend>
      <div role="radiogroup" aria-label={t("legend")} className="grid gap-2 sm:grid-cols-2">
        {options.map(([id, title, hint, Icon]) => {
          const selected = mode === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-option={id}
              onClick={() => onMode(id)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                selected ? "border-orange-400/30 bg-orange-500/10" : "border-white/10 hover:bg-white/5"
              }`}
            >
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${selected ? "border-orange-400/30 text-orange-300" : "border-white/10 text-zinc-400"}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-zinc-100">{title}</span>
                <span className="block text-xs text-zinc-500">{hint}</span>
              </span>
              <span className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-orange-400/30 bg-orange-500 text-white" : "border-white/20"}`} aria-hidden="true">
                {selected && <Check className="h-3 w-3" />}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        {mode === "upload" ? (
          <ResumeDropzone value={pdf} onChange={onPdf} />
        ) : (
          <ExistingResumes sources={sources} sourceKey={sourceKey} onSourceKey={onSourceKey} onUpload={() => onMode("upload")} />
        )}
      </div>
    </fieldset>
  );
}

function ExistingResumes({
  sources,
  sourceKey,
  onSourceKey,
  onUpload,
}: {
  sources: ResumeSourceOption[] | null | "error";
  sourceKey: string;
  onSourceKey: (key: string) => void;
  onUpload: () => void;
}) {
  const t = useTranslations("talentMatch.source");
  const locale = useLocale();

  if (sources === null) {
    return (
      <div className="space-y-2" aria-busy="true">
        <p className="text-xs text-zinc-500">{t("loading")}</p>
        {[0, 1].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" />)}
      </div>
    );
  }
  if (sources === "error") {
    return <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-rose-400">{t("loadFailed")}</p>;
  }
  if (sources.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-5 py-7 text-center" data-state="empty">
        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-orange-400/30 bg-orange-500/10 text-orange-300">
          <FilePlus2 className="h-5 w-5" aria-hidden="true" />
        </span>
        <p className="mt-3 text-sm font-semibold text-zinc-100">{t("emptyTitle")}</p>
        <p className="mt-1 max-w-sm text-xs text-zinc-400">{t("emptyBody")}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link href="/resume" prefetch={false} className={primaryButton}>
            <FilePlus2 className="h-4 w-4" aria-hidden="true" />{t("emptyCta")}
          </Link>
          <button type="button" className={secondaryButton} onClick={onUpload}>{t("emptyUpload")}</button>
        </div>
      </div>
    );
  }

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  return (
    <div>
      <ul role="radiogroup" aria-label={t("listLabel")} className="space-y-2">
        {sources.map((source) => {
          const key = sourceKeyOf(source);
          const selected = key === sourceKey;
          const updated = source.kind === "resume" ? Date.parse(source.updatedAt) : NaN;
          return (
            <li key={key}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSourceKey(key)}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  selected ? "border-orange-400/30 bg-orange-500/10" : "border-white/10 hover:bg-white/5"
                }`}
              >
                {source.kind === "profile"
                  ? <UserRound className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                  : <FileText className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-100">{source.kind === "profile" ? t("profileOption") : source.label}</span>
                  <span className="block text-xs text-zinc-500">
                    {source.kind === "profile" ? t("profileHint") : Number.isFinite(updated) ? t("updated", { date: date.format(updated) }) : null}
                  </span>
                </span>
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-orange-400/30 bg-orange-500 text-white" : "border-white/20"}`} aria-hidden="true">
                  {selected && <Check className="h-3 w-3" />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <Link href="/resume" prefetch={false} className="mt-2 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">
        {t("manage")}<ArrowUpRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    </div>
  );
}
