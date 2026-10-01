import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { AGENT_LINK_HEADER } from "@/lib/agent-docs";
import { deployEnv } from "@/lib/deploy-env";
import { routing } from "@/i18n/routing";
import { decideLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@ghfind/i18n";

const handleI18n = createMiddleware(routing);

function ensureCookie(res: NextResponse, locale: string) {
  res.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
}

/**
 * Advertise the machine surfaces (llms.txt, openapi, sitemap, index.md) on every
 * HTML page, after next-intl's hreflang links. The markdown routes set this
 * header themselves, so the negotiation rewrite branch must NOT go through here
 * (it would duplicate the values on /index.md responses).
 */
function appendAgentLink(res: NextResponse) {
  const existing = res.headers.get("Link");
  res.headers.set(
    "Link",
    existing ? `${existing}, ${AGENT_LINK_HEADER}` : AGENT_LINK_HEADER,
  );
}

/** Preserve any existing Vary value while adding Accept (markdown negotiation). */
function appendVaryAccept(res: NextResponse) {
  const existing = res.headers.get("Vary");
  if (!existing) {
    res.headers.set("Vary", "Accept");
  } else if (!/\baccept\b/i.test(existing)) {
    res.headers.set("Vary", `${existing}, Accept`);
  }
}

export default function proxy(req: NextRequest) {
  const res = route(req);
  // Non-production deployments (dev.ghfind.com) must never enter the index —
  // they mirror production content and would compete with it in search.
  if (deployEnv() !== "production") {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return res;
}

function route(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const decision = decideLocale({
    pathname,
    mode: req.nextUrl.searchParams.get("mode"),
    accept: req.headers.get("accept"),
    acceptLanguage: req.headers.get("accept-language"),
    cookieLocale: req.cookies.get(LOCALE_COOKIE)?.value,
  });

  switch (decision.kind) {
    // Cold-arrival agent negotiation. An AI agent that lands on the homepage from
    // web search either appends `?mode=agent` or sends `Accept: text/markdown`.
    // Serve the canonical markdown twin (/index.md) instead of the ~800KB React
    // homepage. Only the home routes negotiate here — deep pages have their own
    // `.md` twins (e.g. /blog/{slug}.md). `/index.md` contains a dot, so the
    // rewrite target is excluded from this middleware (no rewrite loop).
    case "markdown": {
      const url = req.nextUrl.clone();
      url.pathname = "/index.md";
      url.search = "";
      const res = NextResponse.rewrite(url);
      // Let the CDN key the markdown variant separately from the HTML one.
      res.headers.set("Vary", "Accept");
      return res;
    }

    // Bare zh-root path, but a remembered choice (cookie) or the first-time
    // visitor's Accept-Language top language points elsewhere.
    case "redirect": {
      const url = req.nextUrl.clone();
      url.pathname = decision.location;
      const res = NextResponse.redirect(url);
      ensureCookie(res, decision.locale);
      return res;
    }

    case "render": {
      let res: NextResponse;
      if (decision.explicitDefault) {
        res = NextResponse.next();
      } else if (decision.prefixed) {
        // Already on a locale-prefixed path: render it and remember the choice
        // so a later visit to the bare root honors it.
        res = handleI18n(req);
      } else {
        const rewriteUrl = req.nextUrl.clone();
        rewriteUrl.pathname = pathname === "/" ? "/zh" : `/zh${pathname}`;
        res = NextResponse.rewrite(rewriteUrl);
      }
      ensureCookie(res, decision.locale);
      appendAgentLink(res);
      if (decision.isHome) appendVaryAccept(res);
      return res;
    }
  }
}

export const config = {
  // Run on everything EXCEPT API routes, the MCP transport, Next internals, and
  // static files (any path containing a dot). This keeps `/api/badge`, `/api/card`,
  // etc. — the README-embedded endpoints — prefix-free and untouched. `mcp` is
  // excluded so its same-origin backend rewrite is not captured and rewritten
  // to `/zh/mcp` by next-intl.
  matcher: ["/((?!api|mcp|_next|_vercel|.*\\..*).*)"],
};
