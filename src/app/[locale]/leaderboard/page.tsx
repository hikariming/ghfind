import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LeaderboardPageView } from "@/components/pages/LeaderboardPageView";
import { localeAlternates } from "@/lib/site";
import { loadLeaderboardPage } from "@/lib/pages/leaderboard";
import { asTranslator } from "@/lib/translator";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leaderboard" });
  return {
    title: `${t("heading")} · ${(await getTranslations({ locale, namespace: "meta" }))("siteName")}`,
    description: t("subtitle"),
    alternates: localeAlternates(locale, "/leaderboard"),
  };
}

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ view?: string; window?: string }>;
}) {
  const { locale } = await params;
  const data = await loadLeaderboardPage(await searchParams);
  setRequestLocale(locale);
  const t = await getTranslations("leaderboard");
  return <LeaderboardPageView locale={locale} t={asTranslator(t)} {...data} />;
}
