import Script from "next/script";
import { BotIdClient } from "botid/client";
import AnalyticsGate from "@/components/AnalyticsGate";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** Google Analytics 4 measurement ID (override via env in other environments). */
const GA_MEASUREMENT_ID =
  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? "G-GHXRYBFZEN";

/**
 * Routes whose fetches get a BotID signature attached client-side, so the server
 * can invisibly tell humans from headless farms via checkBotId(). Only the
 * credit-spending LLM route needs this — /api/scan keeps its Turnstile gate, and
 * agents skip BotID entirely by authenticating with a Bearer key (or by being a
 * verified bot).
 */
const BOTID_PROTECTED_ROUTES = [{ path: "/api/roast", method: "POST" as const }];

const THEME_INIT_SCRIPT = `
try {
  var seg = window.location.pathname.split("/")[1];
  var langs = { en: "en", ja: "ja", ko: "ko", es: "es", pt: "pt-BR", id: "id", vi: "vi", ar: "ar" };
  document.documentElement.lang = langs[seg] || "zh-CN";
  document.documentElement.dir = seg === "ar" ? "rtl" : "ltr";

  var key = "github-roast-theme";
  var stored = localStorage.getItem(key);
  var isAdvx =
    window.location.pathname.split("/").indexOf("advx") !== -1 ||
    new URLSearchParams(window.location.search).get("campaign") === "advx";
  if (isAdvx) {
    stored = "dark";
    localStorage.setItem(key, stored);
  }
  var mode = stored === "light" || stored === "dark" || stored === "auto"
    ? stored
    : "auto";
  var theme = mode === "auto"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : mode;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = theme;
} catch (_) {}
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The init script sets data-theme / lang / color-scheme before hydration,
      // so the server markup intentionally differs for saved theme and /en.
      suppressHydrationWarning
    >
      <head>
        <BotIdClient protect={BOTID_PROTECTED_ROUTES} />
      </head>
      <body className="min-h-full flex flex-col">
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        {/* Google tag (gtag.js) - loaded on every page via the root layout */}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
          strategy="afterInteractive"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`
            // navigator.webdriver flags headless automation (scraper farms were
            // inflating GA4 pageviews) — skip config so no hit is ever sent.
            if (!navigator.webdriver) {
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${GA_MEASUREMENT_ID}');
            }
          `}
        </Script>
        {children}
        <AnalyticsGate />
      </body>
    </html>
  );
}
