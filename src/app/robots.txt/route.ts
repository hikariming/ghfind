import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * robots.txt as a route handler (not MetadataRoute.Robots) so we can emit
 * Content-Signal, schemamap, and per-agent tiers that the metadata API can't.
 *
 * Policy (operator decision): "block training, keep retrieval". We welcome the
 * search/answer crawlers so ghfind stays citable in ChatGPT / Claude / Perplexity
 * live answers, but we opt OUT of bulk model-training crawls — vendors split
 * these into separate user agents, so blocking the training bots costs us almost
 * no live-citation reach while retaining leverage over our data/methodology.
 * Blocking is reversible; training inclusion is not. `/api/` stays disallowed (it
 * burns GitHub/LLM/DB budget), except the CDN-cached OG image + card routes.
 */

// Search / answer / user-triggered fetch crawlers — allowed (this is how we get
// cited in AI answers; NOT training). Social preview crawlers get their own
// explicit group so they never have to interpret the generic `/api/` exception
// ordering before fetching `/api/card/...` images.
const ALLOWED_PREVIEW_BOTS = [
  "Twitterbot",
  "facebookexternalhit",
  "Slackbot-LinkExpanding",
  "LinkedInBot",
  "Discordbot",
  "TelegramBot",
  "WhatsApp",
  "Line",
];

const ALLOWED_AI_BOTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Applebot",
];

// Model-training crawlers / opt-out tokens — disallowed so our content does not
// enter training corpora. Blocking these does NOT remove us from the search/answer
// crawlers above. (Google-Extended / Applebot-Extended are training opt-out tokens
// and do not affect Google Search or Siri/Spotlight indexing.)
const BLOCKED_TRAINING_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "Meta-ExternalAgent",
  "meta-externalagent",
  "Amazonbot",
];

export function GET() {
  const lines: string[] = [];

  // Explicit allow tier for social preview crawlers. Keep this group fully open:
  // social scrapers are black boxes, and a later `Disallow: /api/` can make them
  // skip `/api/card/...` even when the card route is explicitly allowed.
  for (const bot of ALLOWED_PREVIEW_BOTS) {
    lines.push(`User-agent: ${bot}`, "Allow: /", "");
  }

  // Explicit allow tier for the search/answer crawlers we welcome.
  for (const bot of ALLOWED_AI_BOTS) {
    lines.push(`User-agent: ${bot}`, "Allow: /", "");
  }

  // Block the training crawlers (and the most aggressive scraper) outright.
  for (const bot of BLOCKED_TRAINING_BOTS) {
    lines.push(`User-agent: ${bot}`, "Disallow: /", "");
  }

  // Everyone else: open, but keep the budget-burning API private (images allowed).
  lines.push(
    "User-agent: *",
    "Allow: /",
    "Allow: /api/og/",
    "Allow: /api/card/",
    "Disallow: /api/",
    "",
    // Cloudflare Content Signals — purpose-based permissions. Opt into search and
    // AI answer input, opt OUT of AI training.
    "Content-Signal: search=yes, ai-input=yes, ai-train=no",
    "",
  );

  lines.push(
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    // NLWeb Schema Feeds: point at the structured-data feed (the OpenAPI spec).
    `Schemamap: ${SITE_URL}/openapi.json`,
    `Host: ${SITE_URL}`,
    "",
  );

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=86400",
    },
  });
}
