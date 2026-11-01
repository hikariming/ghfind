/**
 * Crawler / non-browser detection for cache-write decisions.
 *
 * Profile, project and card traffic is a crawler long tail: each page is
 * fetched about once per cache TTL, so a shared KV entry written on a crawler
 * render is almost never read back — it only costs a KV write. Callers use
 * this to keep such renders on cheaper caches (in-isolate, Cache API).
 *
 * Deliberately broad: a false positive only means a human render skips one KV
 * write, while a false negative costs a write. A missing User-Agent counts as
 * a bot (scripts and many crawlers send none; browsers always do).
 */

const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|scrap|fetcher|preview|externalhit|externalagent|headless|lighthouse|embedly|camo|feedly|okhttp|python-|aiohttp|httpx|curl\/|wget\/|go-http-client|java\/|libwww|axios\/|node-fetch|undici|got \(|ahrefs|semrush|mj12|bytespider|petalbot|yandex|baiduspider|duckduckgo|perplexity|gptbot|chatgpt|claude|anthropic|ccbot|cohere|diffbot|amazonbot|applebot|facebook|whatsapp|telegram|slack|discord|twitter|linkedin|pinterest|skype|vkshare|qwantify|seznam|sogou|exabot|ia_archiver|archive\.org|uptime|monitor|pingdom|statuscake/i;

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = userAgent?.trim();
  if (!ua) return true;
  return BOT_UA.test(ua);
}

type RequestProvider = () => Request | null | undefined;
let requestProvider: RequestProvider | null = null;

/**
 * Each Worker entry (apps/web middleware, apps/api router) registers how to
 * reach the request it is currently serving, so shared library code can ask
 * about it without importing app-specific async storage. Read-only.
 */
export function registerRequestProvider(provider: RequestProvider): void {
  requestProvider = provider;
}

/**
 * Whether the request being served comes from a crawler. False outside a
 * request (scripts, tests, cron) or when no provider is registered: those
 * paths keep their normal caching.
 */
export function isBotRequest(): boolean {
  let request: Request | null | undefined;
  try {
    request = requestProvider?.();
  } catch {
    return false;
  }
  return request ? isBotUserAgent(request.headers.get("user-agent")) : false;
}
