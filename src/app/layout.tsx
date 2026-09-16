import Script from "next/script";
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

// The verdict route's human-check moved from Vercel BotID to Turnstile
// (VsVerdictLive gates its auto-fire on a token; the route verifies it).

const THEME_INIT_SCRIPT = `
try {
  var seg = window.location.pathname.split("/")[1];
  var langs = { en: "en", ja: "ja", ko: "ko", es: "es", pt: "pt-BR", id: "id", vi: "vi", ar: "ar" };
  document.documentElement.lang = langs[seg] || "zh-CN";
  document.documentElement.dir = seg === "ar" ? "rtl" : "ltr";

  var key = "github-roast-theme";
  var stored = null;
  try { stored = localStorage.getItem(key); } catch (_) {}
  var isAdvx =
    window.location.pathname.split("/").indexOf("advx") !== -1 ||
    new URLSearchParams(window.location.search).get("campaign") === "advx";
  if (isAdvx) {
    stored = "dark";
    try { localStorage.setItem(key, stored); } catch (_) {}
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
        {/* Execute while parsing HTML: next/script beforeInteractive waits for
            the Next.js bootstrap and can allow the dark default to paint. */}
        <script
          id="theme-init"
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">
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
