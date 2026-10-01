/**
 * SEO parity check between two deployments of the same site — the gate for
 * every Astro migration phase. For each path × request variant it compares
 * what crawlers and agents see: status, redirects, robots headers, Link
 * header, locale cookie, <html lang/dir>, title, description, canonical,
 * hreflang set, robots meta, OG/Twitter tags, JSON-LD, and the h1.
 *
 *   pnpm tsx scripts/seo-diff.mts <baseA> <baseB> [path ...] [--allow=field,field]
 *     [--sites=https://ghfind.com,https://dev.ghfind.com]
 *
 * Request origins (baseA/baseB) and any `--sites` origins (the configured
 * public SITE_URLs) all normalize to `{host}`, so comparing deployments on
 * different hostnames works. Exits 1 on any unallowed diff.
 */

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("--"));
const positional = argv.filter((a) => !a.startsWith("--"));
const [baseA, baseB, ...pathArgs] = positional;
if (!baseA || !baseB) {
  console.error("usage: seo-diff.mts <baseA> <baseB> [path ...] [--allow=field,...]");
  process.exit(2);
}
const allow = new Set(flags.find((f) => f.startsWith("--allow="))?.slice(8).split(",") ?? []);
const sites = flags.find((f) => f.startsWith("--sites="))?.slice(8).split(",").map((s) => new URL(s).origin) ?? [];

const LOCALES = ["zh", "en", "ja", "ko", "es", "pt", "id", "vi", "ar"];
const paths = pathArgs.length
  ? pathArgs
  : ["/about", ...LOCALES.map((l) => `/${l}/about`)];

// Crawler (no Accept-Language), a returning visitor, and a first-time
// Japanese visitor exercise every locale-routing branch.
const VARIANTS: Record<string, Record<string, string>> = {
  crawler: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  cookieEn: { cookie: "NEXT_LOCALE=en" },
  acceptJa: { "accept-language": "ja-JP,ja;q=0.9,en;q=0.8" },
};

type Snapshot = Record<string, unknown>;

function normalize(text: string, base: string): string {
  const origin = new URL(base).origin;
  let out = text;
  for (const host of [...sites, origin]) out = out.split(host).join("{host}");
  return out;
}

const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1];

const decode = (s: string | undefined) =>
  s?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function snapshotHtml(html: string): Snapshot {
  const head = html.slice(0, Math.max(html.indexOf("</head>"), 0) || html.length);
  const tags = (re: RegExp, src = head) => [...src.matchAll(re)].map((m) => m[0]);
  const metas = tags(/<meta\b[^>]*>/gi);
  const links = tags(/<link\b[^>]*>/gi);
  const meta = (key: string) =>
    decode(attr(metas.find((m) => attr(m, "name") === key || attr(m, "property") === key) ?? "", "content"));
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const hreflang = Object.fromEntries(
    links
      .filter((l) => attr(l, "rel") === "alternate" && (attr(l, "hreflang") ?? attr(l, "hrefLang")))
      .map((l) => [attr(l, "hreflang") ?? attr(l, "hrefLang"), attr(l, "href")])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  const og = Object.fromEntries(
    metas
      .filter((m) => /^(og|twitter):/.test(attr(m, "property") ?? attr(m, "name") ?? ""))
      .map((m) => [attr(m, "property") ?? attr(m, "name"), decode(attr(m, "content"))])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  const jsonLd = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return { unparsable: m[1].slice(0, 80) };
      }
    })
    .map((d) => JSON.stringify(d))
    .sort();
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim();
  return {
    "html.lang": attr(htmlTag, "lang"),
    "html.dir": attr(htmlTag, "dir") ?? "ltr",
    title: decode(head.match(/<title>([\s\S]*?)<\/title>/i)?.[1]),
    description: meta("description"),
    robots: meta("robots") ?? null,
    canonical: attr(links.find((l) => attr(l, "rel") === "canonical") ?? "", "href"),
    hreflang,
    og,
    jsonLd,
    h1: decode(h1),
  };
}

async function snapshotOnce(base: string, path: string, headers: Record<string, string>): Promise<Snapshot> {
  const res = await fetch(new URL(path, base), { headers, redirect: "manual" });
  const cookie = res.headers.get("set-cookie")?.match(/NEXT_LOCALE=([^;]+)/)?.[1] ?? null;
  const snap: Snapshot = {
    status: res.status,
    location: res.headers.get("location") ? new URL(res.headers.get("location")!, base).pathname : null,
    "header.x-robots-tag": res.headers.get("x-robots-tag"),
    // rel=preload entries are performance hints (next/font emits them), not SEO.
    "header.link": res.headers.get("link")?.split(/,\s*(?=<)/).filter((l) => !/rel=preload/.test(l)).map((l) => normalize(l, base)).sort() ?? null,
    "cookie.NEXT_LOCALE": cookie,
  };
  if (res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html")) {
    Object.assign(snap, snapshotHtml(await res.text()));
  }
  return JSON.parse(normalize(JSON.stringify(snap), base));
}

/** Retries the whole fetch + body read: flaky links reset mid-body too. */
async function snapshot(base: string, path: string, headers: Record<string, string>, attempts = 3): Promise<Snapshot> {
  for (let i = 1; ; i++) {
    try {
      return await snapshotOnce(base, path, headers);
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

/** For objects/arrays, report only the members that differ. */
function subDiffs(a: unknown, b: unknown): [string, string, string][] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys]
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => [k, JSON.stringify(a[k]) ?? "∅", JSON.stringify(b[k]) ?? "∅"]);
  }
  return [["value", JSON.stringify(a), JSON.stringify(b)]];
}

let failures = 0;
let allowed = 0;
for (const path of paths) {
  for (const [variant, headers] of Object.entries(VARIANTS)) {
    const [a, b] = await Promise.all([snapshot(baseA, path, headers), snapshot(baseB, path, headers)]);
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const va = JSON.stringify(a[key]);
      const vb = JSON.stringify(b[key]);
      if (va === vb) continue;
      if (allow.has(key)) {
        allowed++;
        continue;
      }
      failures++;
      console.log(`✗ ${path} [${variant}] ${key}`);
      for (const [sub, x, y] of subDiffs(a[key], b[key])) {
        console.log(`    ${sub}\n      A: ${x}\n      B: ${y}`);
      }
    }
  }
}

const checks = paths.length * Object.keys(VARIANTS).length;
console.log(`\n${checks} requests per side, ${failures} diff(s)${allowed ? `, ${allowed} allowed` : ""}.`);
process.exit(failures ? 1 : 0);
