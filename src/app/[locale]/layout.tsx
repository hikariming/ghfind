import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { authConfigured } from "@/lib/auth";
import { Navbar } from "@/components/Navbar";
import { LoginNudge } from "@/components/LoginNudge";
import { PoweredByLobeHub } from "@/components/Sponsor";
import { HtmlLangSync } from "@/components/HtmlLangSync";
import { JsonLd, websiteJsonLd } from "@/components/JsonLd";
import { SITE_URL, localeAlternates } from "@/lib/site";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    metadataBase: new URL(SITE_URL),
    title: t("title"),
    description: t("description"),
    alternates: localeAlternates(locale, "/"),
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: locale === "en" ? "/en" : "/",
      siteName: t("siteName"),
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: t("twDescription"),
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // Enable static rendering for this locale.
  setRequestLocale(locale);
  const tMeta = await getTranslations({ locale, namespace: "meta" });

  // The login nudge gates its own visibility client-side (OAuth configured +
  // signed out, probed via /api/me). We deliberately do NOT read the session
  // here: a server-side auth() reads cookies, which would opt every page out of
  // static/ISR caching — the whole point of this refactor.
  const oauthConfigured = authConfigured();

  return (
    <>
      <JsonLd data={websiteJsonLd({ name: tMeta("siteName"), description: tMeta("description") })} />
      <NextIntlClientProvider>
        <HtmlLangSync locale={locale} />
        <Navbar />
        {children}
        <footer className="flex w-full justify-center py-6">
          <PoweredByLobeHub />
        </footer>
        <LoginNudge configured={oauthConfigured} />
      </NextIntlClientProvider>
    </>
  );
}
