import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { ResumeBuilder } from "@/components/resume/ResumeBuilder";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { title: locale === "zh" ? "我的简历 · ghfind" : "My résumé · ghfind", robots: { index: false, follow: false } };
}
export default async function ResumePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <ResumeBuilder zh={locale === "zh"} />;
}
