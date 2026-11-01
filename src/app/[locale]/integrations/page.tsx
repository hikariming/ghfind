import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { auth } from "@/lib/auth";
import { IntegrationsView } from "@/components/pages/IntegrationsView";
import { installCommand } from "@/lib/integration-install";
import { localeAlternates } from "@/lib/site";
import { asTranslator } from "@/lib/translator";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "integrations" });
  return { title: t("title"), description: t("subtitle"), alternates: localeAlternates(locale, "/integrations") };
}

export default async function IntegrationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, session] = await Promise.all([getTranslations("integrations"), auth()]);
  return <IntegrationsView locale={locale} t={asTranslator(t)} signedIn={Boolean(session)} command={installCommand()} />;
}
