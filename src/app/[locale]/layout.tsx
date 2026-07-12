import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { authConfigured } from "@/lib/auth";
import { Navbar } from "@/components/Navbar";
import { LoginNudge } from "@/components/LoginNudge";
import { SiteFooter } from "@/components/SiteFooter";
import { HtmlLangSync } from "@/components/HtmlLangSync";
import {
  JsonLd,
  websiteJsonLd,
  organizationJsonLd,
  softwareApplicationJsonLd,
} from "@/components/JsonLd";
import { SITE_URL, localeAlternates, localePath } from "@/lib/site";

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
    alternates: {
      ...localeAlternates(locale, "/"),
      // Advertise the machine-readable representations so agents can content-
      // negotiate from the homepage (markdown twin + OpenAPI spec).
      types: {
        "text/markdown": "/index.md",
        "application/openapi+json": "/openapi.json",
      },
    },
    openGraph: {
      title: t("ogTitle"),
      description: t("ogDescription"),
      url: localePath(locale, "/"),
      siteName: t("siteName"),
      type: "website",
      images: [{ url: "/api/og/home", width: 1200, height: 630, alt: t("siteName") }],
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: t("twDescription"),
      images: ["/api/og/home"],
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
      <JsonLd data={organizationJsonLd(tMeta("siteName"))} />
      <JsonLd
        data={softwareApplicationJsonLd({
          name: tMeta("siteName"),
          description: tMeta("description"),
        })}
      />
      <NextIntlClientProvider>
        <HtmlLangSync locale={locale} />
        <Navbar />
        {children}
        <SiteFooter />
        <LoginNudge configured={oauthConfigured} />
      </NextIntlClientProvider>
    </>
  );
}
