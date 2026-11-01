/**
 * Frontend performance baseline for the Astro migration (planning P0).
 *
 * Loads each page in headless Chromium (mobile viewport, cold cache) and
 * records TTFB, FCP, LCP, CLS, and transferred bytes split by resource type.
 * Run it before and after each migration phase against the same base URL.
 *
 *   pnpm tsx scripts/perf-baseline.mts [baseUrl] [--runs=3] [--json=out.json]
 *
 * Defaults to the production workers.dev entrance: the ghfind.com zone WAF
 * challenges headless clients, which would measure the challenge page instead.
 */
import { writeFileSync } from "node:fs";
import { chromium, devices, type Page } from "playwright";

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "https://ghfind.beiming1201.workers.dev").replace(/\/$/, "");
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 3);
const jsonOut = args.find((a) => a.startsWith("--json="))?.slice(7);

const PATHS = [
  "/",
  "/en",
  "/about",
  "/blog",
  "/blog/how-we-score-github-accounts",
  "/leaderboard",
  "/developers",
  "/collections",
  "/u/torvalds",
  "/en/u/torvalds",
];

type Sample = {
  status: number;
  ttfb: number;
  fcp: number;
  lcp: number;
  cls: number;
  bytes: Record<string, number>;
  requests: number;
  cacheControl: string | null;
};

async function measure(page: Page, url: string): Promise<Sample> {
  const bytes: Record<string, number> = {};
  let requests = 0;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const types = new Map<string, string>();
  cdp.on("Network.responseReceived", (e) => types.set(e.requestId, e.type));
  cdp.on("Network.loadingFinished", (e) => {
    requests++;
    const t = (types.get(e.requestId) ?? "Other").toLowerCase();
    const key = t === "script" ? "js" : t === "stylesheet" ? "css" : t === "document" ? "html" : t === "image" ? "img" : t === "font" ? "font" : "other";
    bytes[key] = (bytes[key] ?? 0) + e.encodedDataLength;
  });

  await page.addInitScript(() => {
    const w = window as unknown as { __lcp: number; __cls: number };
    w.__lcp = 0;
    w.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
        if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });

  // Not "networkidle": some pages keep polling and never go idle. Wait for load,
  // then a fixed settle window so late LCP candidates and lazy chunks land.
  const res = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(3000);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const w = window as unknown as { __lcp: number; __cls: number };
    return { ttfb: nav.responseStart - nav.requestStart, fcp, lcp: w.__lcp, cls: w.__cls };
  });
  await cdp.detach();
  return {
    status: res?.status() ?? 0,
    ...m,
    bytes,
    requests,
    cacheControl: res?.headers()["cache-control"] ?? null,
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;

// PW_CHANNEL=chrome reuses the system Chrome instead of a downloaded build.
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL });
const results: Record<string, Sample[]> = {};
for (const path of PATHS) {
  results[path] = [];
  for (let i = 0; i < runs; i++) {
    const ctx = await browser.newContext({ ...devices["Pixel 7"], locale: "zh-CN" });
    const page = await ctx.newPage();
    try {
      results[path].push(await measure(page, base + path));
    } catch (err) {
      console.error(`${path} run ${i + 1} failed:`, (err as Error).message);
    }
    await ctx.close();
  }
}
await browser.close();

console.log(`\nBase: ${base}  runs=${runs}  (median, mobile, cold cache)\n`);
console.log("| path | status | TTFB | FCP | LCP | CLS | JS | CSS | HTML | total | reqs | cache-control |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [path, samples] of Object.entries(results)) {
  if (!samples.length) continue;
  const med = (f: (s: Sample) => number) => median(samples.map(f));
  const total = med((s) => Object.values(s.bytes).reduce((a, b) => a + b, 0));
  console.log(
    `| ${path} | ${samples[0].status} | ${med((s) => s.ttfb).toFixed(0)}ms | ${med((s) => s.fcp).toFixed(0)}ms | ${med((s) => s.lcp).toFixed(0)}ms | ${med((s) => s.cls).toFixed(3)} | ${kb(med((s) => s.bytes.js ?? 0))} | ${kb(med((s) => s.bytes.css ?? 0))} | ${kb(med((s) => s.bytes.html ?? 0))} | ${kb(total)} | ${med((s) => s.requests)} | ${samples[0].cacheControl ?? "-"} |`,
  );
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ base, runs, at: new Date().toISOString(), results }, null, 2));
