import { decideLocale } from "@ghfind/i18n";
import { cardRedirect, cardRequest, serveCard } from "./card-cache";
import { pickTarget } from "./routes";

export interface Env {
  WEB: Fetcher;
  API: Fetcher;
  LEGACY: Fetcher;
  /** "1" sends every request to the legacy Worker (instant rollback via a var change). */
  ROUTER_FORCE_LEGACY?: string;
  /** "1" marks every response noindex (non-production deployments). */
  ROUTER_NOINDEX?: string;
}

/**
 * Agents asking a home route for markdown (`?mode=agent` or `Accept:
 * text/markdown`) get the canonical twin, /index.md — the same negotiation
 * the Next proxy and the Astro middleware run (decideLocale).
 */
function wantsHomeMarkdown(request: Request, url: URL): boolean {
  return (
    decideLocale({
      pathname: url.pathname,
      mode: url.searchParams.get("mode"),
      accept: request.headers.get("accept"),
      acceptLanguage: request.headers.get("accept-language"),
      cookieLocale: undefined,
    }).kind === "markdown"
  );
}

/**
 * Non-production crawl policy. `noindex` keeps pages out of search results but
 * not off the crawl list: serving the production robots.txt and sitemap let
 * meta-webindexer walk ~77k dev pages in a day (SSR, KV writes and prod D1
 * reads on every hit). Disallow everything and publish no sitemap instead.
 */
function nonProductionCrawlResponse(url: URL): Response | null {
  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }
  if (url.pathname === "/sitemap.xml") return new Response("Not found", { status: 404 });
  return null;
}

export default {
  async fetch(request, env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (env.ROUTER_NOINDEX === "1") {
      const crawl = nonProductionCrawlResponse(url);
      if (crawl) return finish(crawl, "router", env);
    }
    const forceLegacy = env.ROUTER_FORCE_LEGACY === "1";
    if (!forceLegacy && wantsHomeMarkdown(request, url)) {
      // /index.md already answers with `Vary: Accept`.
      const res = await env.API.fetch(new Request(new URL("/index.md", url), request));
      return finish(new Response(res.body, res), "api", env);
    }
    // README cards/badges: canonical URL, malformed embeds redirected, isolate
    // cached with stale fallback (card-cache.ts). Rollback bypasses all of it.
    const card = forceLegacy ? null : cardRequest(url);
    if (card && pickTarget(card.canonical.pathname) === "api") {
      if (card.redirect) return finish(cardRedirect(card), "router", env);
      const res = await serveCard(request, card, env.API, {
        waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
      });
      return finish(res, "api", env);
    }
    const target = forceLegacy ? "legacy" : pickTarget(url.pathname);
    const upstream = target === "web" ? env.WEB : target === "api" ? env.API : env.LEGACY;
    // Service bindings keep the original URL/host, so both apps see the
    // public origin exactly as they did behind the custom domain.
    // A request only legacy can answer comes back from web marked for
    // fallback (body-less, so the request is replayed unchanged).
    let served = target;
    let res = await upstream.fetch(target === "web" ? request.clone() : request);
    if (target === "web" && res.status === 404 && res.headers.get("X-Ghfind-Fallback") === "legacy") {
      served = "legacy";
      res = await env.LEGACY.fetch(request);
    }
    return finish(new Response(res.body, res), served, env);
  },
} satisfies ExportedHandler<Env>;

function finish(res: Response, served: string, env: Env): Response {
  res.headers.set("X-Ghfind-Origin", served);
  // Non-production deployments must never enter the index (the Next proxy did
  // this for every route; the API Worker doesn't).
  if (env.ROUTER_NOINDEX === "1") res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
