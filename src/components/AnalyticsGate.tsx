"use client";

import { Analytics } from "@vercel/analytics/next";

/**
 * Headless browsers (scraper farms on rotating proxies) execute our JS and were
 * inflating Vercel Analytics pageviews/events and Speed Insights vitals. Real
 * automation almost always carries `navigator.webdriver === true` (Puppeteer /
 * Playwright / Selenium defaults), so drop those events before they are sent.
 * Stealth-patched bots slip through here — the WAF ASN rules are the second net.
 *
 * SpeedInsights was removed 2026-07-15: stealth bots bypass the webdriver check,
 * so its per-data-point billing mostly measured farm traffic ($8.45/cycle), and
 * ops reviews only use vercel metrics + these custom events anyway. Re-add
 * `<SpeedInsights beforeSend={…}/>` from @vercel/speed-insights/next if needed.
 */
function isAutomated(): boolean {
  return typeof navigator !== "undefined" && navigator.webdriver === true;
}

export default function AnalyticsGate() {
  return <Analytics beforeSend={(event) => (isAutomated() ? null : event)} />;
}
