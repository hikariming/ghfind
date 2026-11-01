import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DevelopersIndexView } from "@/components/pages/DevelopersIndexView";
import { loadDevelopersIndex } from "@/lib/pages/developers";
import { localeAlternates } from "@/lib/site";
import { asTranslator } from "@/lib/translator";

// Everything the directory reads is served from Redis (cache-aside + in-process
// single-flight in lib/developers.ts), so the expensive GROUP BY runs at most
// once per 10-min TTL. force-dynamic here just means "render from that cache",
// never a live DB query per visit.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "developers" });
  const meta = await getTranslations({ locale, namespace: "meta" });
  return {
    title: `${t("metaTitle")} · ${meta("siteName")}`,
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/developers"),
  };
}

export default async function DevelopersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("developers");
  return <DevelopersIndexView t={asTranslator(t)} {...await loadDevelopersIndex()} />;
}
