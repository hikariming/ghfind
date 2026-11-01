import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { AdvxView, pageCopy } from "@/components/pages/AdvxView";
import { getGoCampaignLeaderboard } from "@/lib/go-developers.server";
import { localeAlternates } from "@/lib/site";

// Keep the event page server-rendered for the first paint and crawler HTML, but
// use the same bounded ISR window as the homepage. The route only has the nine
// allow-listed locales from the parent layout, so this cannot create an
// unbounded ISR key space from user input.
export const dynamic = "force-static";
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const copy = pageCopy(locale);
  return {
    title: `${copy.title} · ghfind`,
    description: copy.description,
    alternates: localeAlternates(locale, "/advx"),
  };
}

export default async function AdventureXPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const entries = await getGoCampaignLeaderboard("advx");
  return <AdvxView locale={locale} entries={entries} />;
}
