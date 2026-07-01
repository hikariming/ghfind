import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";

const handleI18n = createMiddleware(routing);

// Same name next-intl uses, so the cookie stays consistent across the stack.
const LOCALE_COOKIE = "NEXT_LOCALE";
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Returns "en" only when the visitor's HIGHEST-priority language is English.
 * A zh-first header like `zh-CN,zh;q=0.9,en;q=0.8` stays Chinese. A missing
 * header (most search-engine crawlers) returns null → we leave them on the zh
 * root so the canonical Chinese URLs keep getting indexed.
 */
function topLanguageIsEnglish(acceptLanguage: string | null): boolean {
  if (!acceptLanguage) return false;
  const top = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      return { tag: tag.toLowerCase(), q: q ? parseFloat(q.slice(2)) : 1 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.q - a.q)[0];
  return top ? top.tag.startsWith("en") : false;
}

function ensureCookie(res: NextResponse, locale: string) {
  res.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: ONE_YEAR,
    sameSite: "lax",
  });
}

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isEnPath = pathname === "/en" || pathname.startsWith("/en/");

  // Already on an English path: render it and remember the choice so a later
  // visit to the bare root honors it.
  if (isEnPath) {
    const res = handleI18n(req);
    ensureCookie(res, "en");
    return res;
  }

  // Chinese root path. Decide the target locale: a remembered choice (cookie)
  // wins; first-time visitors fall back to their Accept-Language top language.
  const cookieLocale = req.cookies.get(LOCALE_COOKIE)?.value;
  const desired =
    cookieLocale === "en" || cookieLocale === "zh"
      ? cookieLocale
      : topLanguageIsEnglish(req.headers.get("accept-language"))
        ? "en"
        : "zh";

  if (desired === "en") {
    const url = req.nextUrl.clone();
    url.pathname = pathname === "/" ? "/en" : `/en${pathname}`;
    const res = NextResponse.redirect(url);
    ensureCookie(res, "en");
    return res;
  }

  const res = handleI18n(req);
  ensureCookie(res, "zh");
  return res;
}

export const config = {
  // Run on everything EXCEPT API routes, Next internals, and static files (any
  // path containing a dot). This keeps `/api/badge`, `/api/card`, etc. — the
  // README-embedded endpoints — prefix-free and untouched.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
