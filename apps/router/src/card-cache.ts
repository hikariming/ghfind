/**
 * README-embedded images (cards and badges): one canonical URL per distinct
 * output, served from the router isolate cache.
 *
 * Worker responses on a custom domain never enter Cloudflare's CDN cache by
 * Cache-Control alone, so before this every card request reached ghfind-api,
 * and the URLs people paste fragment wildly anyway: cache busters (`?v=<ts>`),
 * HTML-escaped embeds (`&amp;theme=dark`, a trailing `&quot;` or `"` on the
 * path or a value) and spelled-out defaults (`?theme=auto`). Each variant
 * re-rendered the card (ghfind-api CPU rose 46 -> 74 ms/request).
 *
 * Here a card URL is reduced to the params its handler reads, with defaults
 * dropped — the cache key. Malformed embeds are 301'd to that URL so they
 * stop at the redirect next time; harmless extras (`v`, unknown params) are
 * just ignored by the key. Responses the handler marks shared-cacheable
 * (`public, s-maxage=N`) are kept in an in-isolate map. The Workers Cache
 * API is unused: `cache.match` miss/expiry is a zone GraphQL 504 on the
 * canonical ghfind.com card URL (`RequestSource: edgeWorkerCacheAPI`).
 */

/** Canonical value for each accepted raw value; anything else (and the
 *  handler's default) is dropped from the key. Must mirror the parsers. */
type ParamRule = Readonly<Record<string, string>>;

interface CardRoute {
  pattern: RegExp;
  params: Readonly<Record<string, ParamRule>>;
  /** A param that switches the response to `no-store` (never cached). */
  bypass?: (params: URLSearchParams) => boolean;
}

const LIGHT_THEME: ParamRule = { light: "light" }; // parseTheme: anything else is dark
const ZH_LANG: ParamRule = { zh: "zh" };
const QR: ParamRule = { "1": "1", true: "1" }; // parseQr

const CARD_ROUTES: readonly CardRoute[] = [
  {
    // src/lib/mini-card.ts parseMiniCard*: bars / auto / en are the defaults.
    pattern: /^\/api\/card\/mini\/[^/]+$/,
    params: { variant: { radar: "radar", strip: "strip" }, theme: { dark: "dark", light: "light" }, lang: ZH_LANG },
  },
  {
    pattern: /^\/api\/card\/vs\/[^/]+\/[^/]+$/,
    params: { theme: LIGHT_THEME, qr: QR, lang: ZH_LANG },
  },
  {
    // cards.tsx parseVariant: "score" is the default.
    pattern: /^\/api\/card\/[^/]+$/,
    params: {
      theme: LIGHT_THEME,
      qr: QR,
      variant: { contrib: "contrib", pr: "pr", path: "path", work: "work" },
    },
  },
  {
    pattern: /^\/api\/material-card\/[^/]+$/,
    params: { theme: LIGHT_THEME },
    bypass: (params) => params.get("preview") === "1",
  },
  {
    pattern: /^\/api\/badge\/[^/]+$/,
    params: { lang: ZH_LANG },
  },
];

// What a broken HTML embed leaves behind: a literal or escaped double quote.
const QUOTE_JUNK = /(?:&quot;?|&#34;?|"|%22|%26quot(?:%3B|;)?)+$/i;
const AMP_PREFIX = /^(?:amp;)+/i;
const QUOT_KEY = /^quot;?$/i;

export interface CardRequest {
  /** The URL the handler sees and the cache key: clean path, canonical params. */
  canonical: URL;
  /** The request URL was malformed: answer with a permanent redirect. */
  redirect: boolean;
  /** Never cached (e.g. the material-card preview). */
  bypass: boolean;
}

/** Exact match, like the handlers' parsers; own keys only (no `constructor`). */
function canonicalValue(route: CardRoute, key: string, value: string): string | null {
  if (!Object.hasOwn(route.params, key)) return null;
  const rule = route.params[key]!;
  return Object.hasOwn(rule, value) ? rule[value]! : null;
}

export function cardRequest(url: URL): CardRequest | null {
  const pathname = url.pathname.replace(QUOTE_JUNK, "");
  const route = CARD_ROUTES.find((candidate) => candidate.pattern.test(pathname));
  if (!route) return null;
  let malformed = pathname !== url.pathname;
  const params = new URLSearchParams();
  for (const [rawKey, rawValue] of url.searchParams) {
    const key = rawKey.replace(AMP_PREFIX, "");
    if (key !== rawKey) malformed = true;
    if (QUOT_KEY.test(key)) {
      malformed = true;
      continue;
    }
    const value = rawValue.replace(QUOTE_JUNK, "");
    if (value !== rawValue) malformed = true;
    // First occurrence wins, like URLSearchParams.get in the handlers.
    if (params.has(key)) continue;
    const canonical = canonicalValue(route, key, value);
    if (canonical !== null) params.set(key, canonical);
  }
  params.sort();
  const canonical = new URL(url.origin);
  canonical.pathname = pathname;
  canonical.search = params.toString();
  return { canonical, redirect: malformed, bypass: route.bypass?.(url.searchParams) ?? false };
}

const REDIRECT_CACHE_CONTROL = "public, max-age=86400";

export function cardRedirect(card: CardRequest): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: card.canonical.toString(), "Cache-Control": REDIRECT_CACHE_CONTROL },
  });
}

interface SharedPolicy {
  freshSeconds: number;
  staleSeconds: number;
}

/** Fresh TTL from s-maxage, plus stale-while-revalidate for background refresh. */
function sharedPolicy(res: Response): SharedPolicy {
  if (res.status !== 200 || res.headers.has("Set-Cookie")) return { freshSeconds: 0, staleSeconds: 0 };
  const cacheControl = res.headers.get("Cache-Control")?.toLowerCase() ?? "";
  if (!/\bpublic\b/.test(cacheControl) || /\b(?:no-store|private|no-cache)\b/.test(cacheControl)) {
    return { freshSeconds: 0, staleSeconds: 0 };
  }
  const fresh = Number(/\bs-maxage=(\d+)/.exec(cacheControl)?.[1] ?? 0);
  const stale = Number(/\bstale-while-revalidate=(\d+)/.exec(cacheControl)?.[1] ?? 0);
  return {
    freshSeconds: Number.isFinite(fresh) ? fresh : 0,
    staleSeconds: Number.isFinite(stale) ? stale : 0,
  };
}

export const CARD_CACHE_HEADER = "X-Ghfind-Card-Cache";
export type CardCacheStatus = "HIT" | "STALE" | "MISS" | "BYPASS";

interface StoredCard {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
  freshUntil: number;
  staleUntil: number;
}

const ISOLATE_MAX = 500;
const isolate = new Map<string, StoredCard>();
const revalidating = new Set<string>();

/** Test-only: the isolate map is process-global in Node. */
export function resetCardIsolate(): void {
  isolate.clear();
  revalidating.clear();
}

function remember(key: string, entry: StoredCard): void {
  isolate.delete(key);
  isolate.set(key, entry);
  while (isolate.size > ISOLATE_MAX) {
    const oldest = isolate.keys().next().value;
    if (oldest === undefined) break;
    isolate.delete(oldest);
  }
}

function touch(key: string): StoredCard | undefined {
  const entry = isolate.get(key);
  if (!entry) return undefined;
  isolate.delete(key);
  isolate.set(key, entry);
  return entry;
}

function toResponse(entry: StoredCard, method: string): Response {
  return new Response(method === "HEAD" ? null : entry.body.slice(0), {
    status: entry.status,
    headers: new Headers(entry.headers),
  });
}

function originFailed(res: Response): boolean {
  return res.status >= 500;
}

async function capture(res: Response, policy: SharedPolicy, now: number): Promise<StoredCard> {
  const body = await res.arrayBuffer();
  return {
    status: res.status,
    headers: [...res.headers],
    body,
    freshUntil: now + policy.freshSeconds * 1000,
    staleUntil: now + (policy.freshSeconds + policy.staleSeconds) * 1000,
  };
}

async function revalidate(key: string, canonical: URL, request: Request, upstream: Fetcher): Promise<void> {
  if (revalidating.has(key)) return;
  revalidating.add(key);
  try {
    const res = await upstream.fetch(new Request(canonical, { method: "GET", headers: request.headers }));
    const now = Date.now();
    const policy = sharedPolicy(res);
    if (originFailed(res) || policy.freshSeconds <= 0) {
      await res.body?.cancel();
      return;
    }
    remember(key, await capture(res, policy, now));
  } catch {
    // Keep the stale copy.
  } finally {
    revalidating.delete(key);
  }
}

export async function serveCard(
  request: Request,
  card: CardRequest,
  upstream: Fetcher,
  options: { waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<Response> {
  const forward = new Request(card.canonical, request);
  const cacheable = !card.bypass && (request.method === "GET" || request.method === "HEAD");
  if (!cacheable) {
    return mark(await upstream.fetch(card.bypass ? request : forward), "BYPASS");
  }
  const key = card.canonical.toString();
  const now = Date.now();
  const cached = touch(key);
  if (cached && cached.freshUntil > now) {
    return mark(toResponse(cached, request.method), "HIT");
  }
  if (cached && cached.staleUntil > now) {
    const refresh = revalidate(key, card.canonical, request, upstream);
    if (options.waitUntil) options.waitUntil(refresh);
    else void refresh;
    return mark(toResponse(cached, request.method), "STALE");
  }
  let res: Response;
  try {
    res = await upstream.fetch(forward);
  } catch (error) {
    if (cached) return mark(toResponse(cached, request.method), "STALE");
    throw error;
  }
  if (originFailed(res) && cached) {
    await res.body?.cancel();
    return mark(toResponse(cached, request.method), "STALE");
  }
  const policy = request.method === "GET" ? sharedPolicy(res) : { freshSeconds: 0, staleSeconds: 0 };
  if (policy.freshSeconds <= 0) return mark(res, "MISS");
  const stored = await capture(res, policy, now);
  remember(key, stored);
  return mark(toResponse(stored, request.method), "MISS");
}

function mark(res: Response, status: CardCacheStatus): Response {
  const out = new Response(res.body, res);
  out.headers.set(CARD_CACHE_HEADER, status);
  return out;
}
