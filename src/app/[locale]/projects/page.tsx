import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { ProjectAnalysisForm } from "@/components/ProjectAnalysisForm";
import {
  ProjectAssessmentCard,
  type ProjectAssessmentCardLabels,
} from "@/components/ProjectAssessmentCard";
import {
  listProjectBoard,
  ProjectAnalysisDatabaseError,
  countProjectBoard,
  type ProjectBoard,
} from "@/lib/project-analysis-db";
import { getGoPublicData, goBackendOrigin } from "@/lib/go-backend.server";
import { localeAlternates } from "@/lib/site";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 18;

function parseBoard(value: unknown): ProjectBoard {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (scalar === "classic") return "classic";
  if (scalar === "all") return "all";
  return "treasure";
}

function parsePage(value: unknown): number {
  const scalar = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(scalar ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "projectBoards" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/projects"),
  };
}

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ board?: string | string[]; page?: string | string[] }>;
}) {
  const { locale } = await params;
  const query = (await searchParams) ?? {};
  setRequestLocale(locale);
  const t = await getTranslations("projectBoards");
  const board = parseBoard(query.board);
  const page = parsePage(query.page);
  let databaseError: string | null = null;
  let entries = [] as Awaited<ReturnType<typeof listProjectBoard>>;
  let total = 0;
  if (goBackendOrigin()) {
    // The Go backend owns the board read when it is configured; the local
    // Turso path below is the local-dev fallback only.
    const fromGo = await getGoPublicData<{
      entries: Awaited<ReturnType<typeof listProjectBoard>>;
      total: number;
    }>(`/api/project-boards?board=${board}&limit=${PAGE_SIZE + 1}&offset=${(page - 1) * PAGE_SIZE}`);
    if (fromGo) {
      entries = fromGo.entries;
      total = fromGo.total;
    }
    else databaseError = "Go backend board read failed";
  } else {
    try {
      entries = await listProjectBoard(board, {
        limit: PAGE_SIZE + 1,
        offset: (page - 1) * PAGE_SIZE,
      });
      total = await countProjectBoard(board);
    } catch (error) {
      if (!(error instanceof ProjectAnalysisDatabaseError)) throw error;
      const fallback = await getGoPublicData<{
        entries: Awaited<ReturnType<typeof listProjectBoard>>;
        total: number;
      }>(`/api/project-boards?board=${board}&limit=${PAGE_SIZE + 1}&offset=${(page - 1) * PAGE_SIZE}`);
      if (fallback) {
        entries = fallback.entries;
        total = fallback.total;
      }
      else databaseError = error.message;
    }
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) {
    redirect(`/projects?board=${board}&page=${totalPages}`);
  }
  const currentPage = page;
  const hasNext = currentPage < totalPages;
  const visibleEntries = entries.slice(0, PAGE_SIZE);
  const cardLabels: ProjectAssessmentCardLabels = {
    productScore: t("productScore"),
    confidence: t("confidence"),
    communityStrength: t("communityStrength"),
    viewReport: t("viewReport"),
    treasure: t("boards.treasure"),
    classic: t("boards.classic"),
    unranked: t("boards.unranked"),
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold uppercase tracking-wide text-orange-400">
            {t("eyebrow")}
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-zinc-100 sm:text-5xl">
            {t("heading")}
          </h1>
          <p className="mt-3 text-base leading-relaxed text-zinc-400 sm:text-lg">
            {t("subtitle")}
          </p>
        </div>
        <a
          href="https://mosoo.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="mr-4 inline-flex shrink-0 items-center gap-3 rounded-full border border-white/10 bg-white/5 px-6 py-4 text-lg text-zinc-300 transition-colors hover:bg-white/10 sm:mr-8"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/mosoo.svg" alt="mosoo" className="h-8 w-8 rounded" />
          <span className="text-zinc-500">Powered by</span>
          <span className="font-semibold text-zinc-200">mosoo</span>
        </a>
      </header>

      <ProjectAnalysisForm />

      <nav className="mt-8 flex gap-2" aria-label={t("boardLabel")}>
        {(["treasure", "classic", "all"] as const).map((value) => (
          <Link
            key={value}
            href={value === "treasure" ? "/projects" : `/projects?board=${value}`}
            aria-current={board === value ? "page" : undefined}
            className={`rounded-full border px-4 py-2 text-sm font-bold ${
              board === value
                ? "border-orange-400/50 bg-orange-500/15 text-orange-200"
                : "border-white/10 text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
            }`}
          >
            {t(`boards.${value}`)}
          </Link>
        ))}
      </nav>
      <p className="mt-3 text-sm text-zinc-500">{t(`boardDescriptions.${board}`)}</p>

      {databaseError ? (
        <section className="mt-6 rounded-2xl border border-amber-400/20 bg-amber-500/10 p-5 text-sm text-amber-200">
          {t("databaseUnavailable")}
        </section>
      ) : visibleEntries.length > 0 ? (
        <section className="mt-6 grid gap-4 lg:grid-cols-2" aria-label={t("listLabel")}>
          {visibleEntries.map((assessment) => (
            <ProjectAssessmentCard
              key={assessment.repoKey}
              assessment={assessment}
              labels={cardLabels}
              locale={locale}
            />
          ))}
        </section>
      ) : (
        <section className="mt-6 rounded-2xl border border-dashed border-white/10 px-6 py-16 text-center">
          <h2 className="text-lg font-bold text-zinc-200">{t("emptyTitle")}</h2>
          <p className="mt-2 text-sm text-zinc-500">{t(`emptyBody.${board}`)}</p>
        </section>
      )}

      {(currentPage > 1 || hasNext) && (
        <nav className="mt-6 flex flex-wrap items-center justify-between gap-4 text-sm">
          <Link
            href={`/projects?board=${board}&page=${Math.max(1, currentPage - 1)}`}
            aria-disabled={currentPage <= 1}
            className={currentPage <= 1 ? "pointer-events-none text-zinc-700" : "text-zinc-300"}
          >
            {t("prev")}
          </Link>
          <span className="text-zinc-500">
            {t("pageOf", { page: currentPage, totalPages })} · {t("total", { count: total })}
          </span>
          <form action="/projects" method="get" className="flex items-center gap-2">
            <input type="hidden" name="board" value={board} />
            <label htmlFor="project-page" className="sr-only">{t("jump")}</label>
            <input
              id="project-page"
              name="page"
              type="number"
              min="1"
              max={totalPages}
              defaultValue={currentPage}
              className="w-16 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-center text-zinc-200 outline-none focus:border-orange-400/50"
            />
            <button type="submit" className="rounded-lg border border-white/10 px-3 py-1.5 text-zinc-300 hover:bg-white/5">
              {t("jump")}
            </button>
          </form>
          <Link
            href={`/projects?board=${board}&page=${Math.min(totalPages, currentPage + 1)}`}
            aria-disabled={currentPage >= totalPages}
            className={currentPage >= totalPages ? "pointer-events-none text-zinc-700" : "text-zinc-300"}
          >
            {t("next")}
          </Link>
        </nav>
      )}
    </main>
  );
}
