import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FollowingView } from "@/components/pages/FollowingView";
import { localeAlternates } from "@/lib/site";
import { asTranslator } from "@/lib/translator";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "follow" });
  const tMeta = await getTranslations({ locale, namespace: "meta" });
  return {
    title: `${t("pageTitle")} · ${tMeta("siteName")}`,
    description: t("pageSubtitle"),
    alternates: localeAlternates(locale, "/following"),
    robots: { index: false, follow: false },
  };
}

export default async function FollowingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("follow");
  return <FollowingView t={asTranslator(t)} />;
}
