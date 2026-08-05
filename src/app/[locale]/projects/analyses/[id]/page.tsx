import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ProjectAnalysisStatus } from "@/components/ProjectAnalysisStatus";
import {
  getPublicProjectAnalysisView,
  ProjectAnalysisServiceError,
  type PublicProjectAnalysisView,
} from "@/lib/project-analysis-service";
import { getGoPublicData, goBackendOrigin } from "@/lib/go-backend.server";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "projectAnalysis" });
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

export default async function ProjectAnalysisPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  let view: PublicProjectAnalysisView | null = null;
  if (goBackendOrigin()) {
    // The Go backend owns the public analysis view after the extraction; the
    // in-process Turso/Mosoo path below is the local-dev fallback only.
    view = await getGoPublicData<PublicProjectAnalysisView>(
      `/api/project-analyses/${encodeURIComponent(id)}`,
    );
    if (view) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
          <ProjectAnalysisStatus initial={view} />
        </main>
      );
    }
  }
  try {
    view = await getPublicProjectAnalysisView(id, true);
  } catch (error) {
    if (error instanceof ProjectAnalysisServiceError && error.status === 404) notFound();
    view = await getGoPublicData<PublicProjectAnalysisView>(
      `/api/project-analyses/${encodeURIComponent(id)}`,
    );
  }
  if (!view) notFound();
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
      <ProjectAnalysisStatus initial={view} />
    </main>
  );
}
