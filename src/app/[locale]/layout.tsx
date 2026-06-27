import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Analytics } from "@vercel/analytics/next";
import { Geist, Geist_Mono } from "next/font/google";
import { routing } from "@/i18n/routing";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { PoweredByLobeHub } from "@/components/Sponsor";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** HTML `lang` attribute per locale (zh keeps its region tag for SEO). */
const HTML_LANG: Record<string, string> = { zh: "zh-CN", en: "en" };

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
    metadataBase: new URL("https://githubroast.icu"),
    title: t("title"),
    description: t("description"),
    alternates: {
      languages: { "zh-CN": "/", en: "/en" },
    },
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

  return (
    <html
      lang={HTML_LANG[locale] ?? "zh-CN"}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider>
          {/* The GitHub login area (SiteHeader) belongs to the separate auth
              feature; this i18n layout only owns the language switcher so it
              builds standalone on main. Re-add <SiteHeader /> here when the auth
              feature lands. */}
          <header className="flex w-full justify-end px-5 py-3">
            <LanguageSwitcher />
          </header>
          {children}
          <footer className="flex w-full justify-center py-6">
            <PoweredByLobeHub />
          </footer>
          <Analytics />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
