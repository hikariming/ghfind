import { defineMiddleware } from "astro:middleware";
import { decideLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, splitLocale } from "@ghfind/i18n";
import { AGENT_LINK_HEADER } from "@/lib/agent-docs";
import { deployEnv } from "@/lib/deploy-env";

/**
 * Locale routing with the exact semantics of the Next app's `src/proxy.ts`
 * (both call `decideLocale` from @ghfind/i18n): cookie → Accept-Language →
 * zh root, zh served unprefixed via an internal rewrite to `/zh/...`.
 */
export const onRequest = defineMiddleware(async (ctx, next) => {
  const { pathname, search } = ctx.url;
  // Static assets and non-page routes skip locale handling (same as the
  // Next matcher: anything with a dot, and the Astro build output).
  if (pathname.startsWith("/_astro/") || pathname.startsWith("/_server-islands/") || /\/[^/]*\.[^/]+$/.test(pathname)) {
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
      // The router only sends migrated paths here; home (the only negotiating
      // route) stays on the Next app until P3, when /index.md moves too.
      res = await next("/index.md");
      res.headers.set("Vary", "Accept");
      return withRobots(res);
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
});

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
