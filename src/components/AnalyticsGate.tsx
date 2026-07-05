"use client";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

/**
 * Headless browsers (scraper farms on rotating proxies) execute our JS and were
 * inflating Vercel Analytics pageviews/events and Speed Insights vitals. Real
 * automation almost always carries `navigator.webdriver === true` (Puppeteer /
 * Playwright / Selenium defaults), so drop those events before they are sent.
 * Stealth-patched bots slip through here — the WAF ASN rules are the second net.
 */
function isAutomated(): boolean {
  return typeof navigator !== "undefined" && navigator.webdriver === true;
}

export default function AnalyticsGate() {
  return (
    <>
      <Analytics beforeSend={(event) => (isAutomated() ? null : event)} />
      <SpeedInsights beforeSend={(data) => (isAutomated() ? null : data)} />
    </>
  );
}
