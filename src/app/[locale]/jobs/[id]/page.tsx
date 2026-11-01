import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { JobDetailView } from "@/components/pages/JobDetailView";
import { getJob } from "@/lib/jobs";
import { localeAlternates } from "@/lib/site";
import { asTranslator } from "@/lib/translator";

// Reads the job from D1 per request (the build has no D1 binding).
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale, id } = await params;
  const job = await getJob(locale, id);
  if (!job) return {};
  return {
    title: `${job.title} · ${job.company.name} · ghfind`,
    description: job.summary ?? undefined,
    alternates: localeAlternates(locale, `/jobs/${id}`),
  };
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const job = await getJob(locale, id);
  if (!job) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("jobs");
  return <JobDetailView t={asTranslator(t)} job={job} />;
}
