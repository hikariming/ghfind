import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme-init";
import { CONSENT_INIT_SCRIPT } from "@/lib/consent-init";

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
 * Funding Choices (Google-certified CMP) tag URL, from AdSense → Privacy &
 * messaging. Unset until the AdSense account exists; the consent defaults
 * above keep EEA/UK/CH compliant in the meantime.
 */
const FUNDING_CHOICES_URL = process.env.NEXT_PUBLIC_FUNDING_CHOICES_URL;

// The verdict route's human-check moved from Vercel BotID to Turnstile
// (VsVerdictLive gates its auto-fire on a token; the route verifies it).


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
        {/* Consent Mode defaults must sit in <head>, ahead of gtag.js. */}
        <script
          id="consent-init"
          dangerouslySetInnerHTML={{ __html: CONSENT_INIT_SCRIPT }}
        />
        {FUNDING_CHOICES_URL ? (
          <script async src={FUNDING_CHOICES_URL} />
        ) : null}
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
      </body>
    </html>
  );
}
