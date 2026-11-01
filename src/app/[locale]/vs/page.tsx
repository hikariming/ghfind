import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getGoTrendingVsMatchups } from "@/lib/go-profile.server";
import { VsIndexView } from "@/components/pages/VsIndexView";
import { localeAlternates } from "@/lib/site";
import { asTranslator } from "@/lib/translator";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "vs" });
  return {
    title: t("trendingHeading"),
    description: t("trendingSub"),
    alternates: localeAlternates(locale, "/vs"),
  };
}

export default async function VsIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("vs");
  const matchups = await getGoTrendingVsMatchups();
  return <VsIndexView locale={locale} t={asTranslator(t)} matchups={matchups} />;
}
