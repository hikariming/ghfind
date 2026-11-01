import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { TalentMatch } from "@/components/talent-match/TalentMatch";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: locale === "zh" ? "人才匹配 · ghfind" : "Talent Match · ghfind", robots: { index: false, follow: false } };
}
export default async function TalentMatchPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <TalentMatch zh={locale === "zh"} />;
}
