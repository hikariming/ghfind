import { defineMiddleware } from "astro:middleware";
import { decideLocale, isDeveloperFacetPath, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, splitLocale } from "@ghfind/i18n";
import { AGENT_LINK_HEADER } from "@/lib/agent-docs";
import { registerRequestProvider } from "@/lib/bot-user-agent";
import { deployEnv } from "@/lib/deploy-env";
import { requestStore } from "./shims/request-store";
import { notFoundToLegacy } from "./lib/not-found";

/**
 * Locale routing with the exact semantics of the Next app's `src/proxy.ts`
 * (both call `decideLocale` from @ghfind/i18n): cookie → Accept-Language →
 * zh root, zh served unprefixed via an internal rewrite to `/zh/...`.
 */
// Shared caching code skips KV writes on crawler renders (lib/bot-user-agent).
registerRequestProvider(() => requestStore.getStore());

export const onRequest = defineMiddleware((ctx, next) => requestStore.run(ctx.request, () => route(ctx, next)));

const route: Parameters<typeof defineMiddleware>[0] = async (ctx, next) => {
  const { pathname, search } = ctx.url;
  // Static assets and non-page routes skip locale handling (same as the
  // Next matcher: file-like paths except developer facet values, plus build output).
  if (pathname.startsWith("/_astro/") || pathname.startsWith("/_server-islands/") || (!isDeveloperFacetPath(pathname) && /\/[^/]*\.[^/]+$/.test(pathname))) {
    return next();
  }

  // Next's default: `/en/about/` → 308 `/en/about`, so both URL shapes keep
  // resolving to one canonical page.
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return withRobots(new Response(null, { status: 308, headers: { Location: pathname.replace(/\/+$/, "") + search } }));
  }

  const decision = decideLocale({
    pathname,
    mode: ctx.url.searchParams.get("mode"),
    accept: ctx.request.headers.get("accept"),
    acceptLanguage: ctx.request.headers.get("accept-language"),
    cookieLocale: ctx.cookies.get(LOCALE_COOKIE)?.value,
  });

  let res: Response;
  switch (decision.kind) {
    case "markdown": {
      // Agent negotiation on the home route: the markdown twin is served by the
      // legacy Worker (/index.md), so hand the request back to it unchanged.
      return notFoundToLegacy();
    }
    case "redirect": {
      res = new Response(null, { status: 307, headers: { Location: decision.location + search } });
      rememberLocale(res, decision.locale);
      return withRobots(res);
    }
    case "render": {
      res = decision.prefixed ? await next() : await next(`/zh${pathname === "/" ? "" : pathname}${search}`);
      res = mutable(res);
      rememberLocale(res, decision.locale);
      if (decision.prefixed && !decision.explicitDefault) appendLink(res, hreflangLinks(ctx.url, pathname));
      appendLink(res, AGENT_LINK_HEADER);
      if (decision.isHome) res.headers.append("Vary", "Accept");
      return withRobots(res);
    }
  }
};

function mutable(res: Response): Response {
  try {
    res.headers.set("X-Ghfind-Web", "1");
    return res;
  } catch {
    return new Response(res.body, res);
  }
}

function rememberLocale(res: Response, locale: string) {
  res.headers.append(
    "Set-Cookie",
    `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=lax`,
  );
}

function appendLink(res: Response, value: string) {
  const existing = res.headers.get("Link");
  res.headers.set("Link", existing ? `${existing}, ${value}` : value);
}

/**
 * next-intl's middleware advertises alternates as a `Link` header on
 * prefixed-locale responses (request origin, bare locale codes as hreflang).
 * Reproduced verbatim so the SEO diff stays clean.
 */
function hreflangLinks(url: URL, pathname: string): string {
  const { path } = splitLocale(pathname);
  const locales = ["zh", "en", "ja", "ko", "es", "pt", "id", "vi", "ar"];
  const at = (l: string) => `${url.origin}${l === "zh" ? (path === "/" ? "" : path) || "/" : `/${l}${path === "/" ? "" : path}`}`;
  return [
    ...locales.map((l) => `<${at(l)}>; rel="alternate"; hreflang="${l}"`),
    `<${at("zh")}>; rel="alternate"; hreflang="x-default"`,
  ].join(", ");
}

/** Non-production deployments must never enter the index. */
function withRobots(res: Response): Response {
  if (deployEnv() !== "production") res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
