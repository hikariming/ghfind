"use client";

import { FormEvent, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";

interface CreateAnalysisResponse {
  analysisId?: string;
  error?: string;
  message?: string;
}

function toRepositoryPath(value: string) {
  return value
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
    .replace(/^github\.com\//i, "");
}

export function ProjectAnalysisForm() {
  const t = useTranslations("projects.analysisForm");
  const router = useRouter();
  const [repository, setRepository] = useState("");
  const [requestedRef, setRequestedRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/project-analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryUrl: repository.trim(),
          ref: requestedRef.trim() || undefined,
        }),
      });
      const result = (await response.json()) as CreateAnalysisResponse;
      if (!response.ok || !result.analysisId) {
        throw new Error(result.message || result.error || t("unknownError"));
      }
      router.push(`/projects/analyses/${result.analysisId}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("unknownError"));
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-border bg-card p-5"
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem_auto] md:items-end">
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-zinc-200">
            {t("repositoryLabel")}
          </span>
          <input
            required
            type="text"
            name="repository"
            value={repository}
            onChange={(event) => setRepository(toRepositoryPath(event.target.value))}
            placeholder={t("repositoryPlaceholder")}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-xl border border-border bg-input px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold text-zinc-200">
            {t("refLabel")}
          </span>
          <input
            type="text"
            name="ref"
            value={requestedRef}
            onChange={(event) => setRequestedRef(event.target.value)}
            placeholder={t("refPlaceholder")}
            className="w-full rounded-xl border border-border bg-input px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60"
        >
          {submitting ? t("submitting") : t("submit")}
        </button>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-zinc-500">{t("safetyHint")}</p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-rose-400">
          {error}
        </p>
      )}
    </form>
  );
}
