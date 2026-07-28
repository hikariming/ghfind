import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ProjectAnalysisStatus } from "@/components/ProjectAnalysisStatus";
import {
  getPublicProjectAnalysisView,
  ProjectAnalysisServiceError,
} from "@/lib/project-analysis-service";

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
  let view;
  try {
    view = await getPublicProjectAnalysisView(id, true);
  } catch (error) {
    if (error instanceof ProjectAnalysisServiceError && error.status === 404) notFound();
    throw error;
  }
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-14 sm:px-6 sm:py-20">
      <ProjectAnalysisStatus initial={view} />
    </main>
  );
}
