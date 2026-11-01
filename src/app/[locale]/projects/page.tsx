import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { ProjectsView } from "@/components/pages/ProjectsView";
import { loadProjectsPage } from "@/lib/pages/projects";
import { localeAlternates } from "@/lib/site";
import { asTranslator } from "@/lib/translator";

export const dynamic = "force-dynamic";
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
  const { redirectTo, ...data } = await loadProjectsPage(query);
  if (redirectTo) redirect(redirectTo);
  return <ProjectsView locale={locale} t={asTranslator(t)} {...data} />;
}
