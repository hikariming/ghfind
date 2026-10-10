import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { JobsView } from "@/components/pages/JobsView";
import { loadJobsPage } from "@/lib/pages/jobs";
import { localeAlternates } from "@/lib/site";
import { asTranslator } from "@/lib/translator";

// Reads the hiring board from D1 per request (filterable by ?company=).
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "jobs" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/jobs"),
  };
}

export default async function JobsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ company?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const company = (await searchParams).company;
  const [t, data] = await Promise.all([
    getTranslations("jobs"),
    loadJobsPage(locale, Array.isArray(company) ? company[0] : company),
  ]);
  return <JobsView t={asTranslator(t)} {...data} />;
}
