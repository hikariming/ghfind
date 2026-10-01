import { DEFAULT_LOCALE, isLocale, PREFIXED_LOCALES, type Locale } from "./config";

/**
 * Maps the visitor's HIGHEST-priority Accept-Language to a supported locale, or
 * null when it doesn't match one. A zh-first header like
 * `zh-CN,zh;q=0.9,en;q=0.8` stays Chinese; `ja-JP,en;q=0.8` maps to ja. A
 * missing header (most search-engine crawlers) returns null → we leave them on
 * the zh root so the canonical Chinese URLs keep getting indexed.
 */
export function topSupportedLanguage(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) return null;
  const top = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.toLowerCase(), q: q ? parseFloat(q.slice(2)) : 1 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.q - a.q)[0];
  if (!top) return null;
  const primary = top.tag.split("-")[0];
  return isLocale(primary) ? primary : null;
}

export interface LocaleRequest {
  pathname: string;
  /** Value of the `?mode=` query parameter, if any. */
  mode?: string | null;
  accept?: string | null;
  acceptLanguage?: string | null;
  cookieLocale?: string | null;
}

/**
 * What a frontend should do with an incoming page request. Every variant that
 * renders a page carries the locale to remember in the `NEXT_LOCALE` cookie.
 *
 * - `markdown`: cold-arrival agent negotiation on a home route — serve the
 *   `/index.md` twin (with `Vary: Accept`) instead of the HTML homepage.
 * - `render`: render `locale` for this path. `explicitDefault` marks an
 *   explicit `/zh` URL, which renders as-is without the home `Vary` header.
 * - `redirect`: bare zh-root path, but the visitor prefers another locale
 *   (cookie first, then Accept-Language) — redirect to `location`.
 */
export type LocaleDecision =
  | { kind: "markdown" }
  | { kind: "render"; locale: Locale; isHome: boolean; prefixed: boolean; explicitDefault: boolean }
  | { kind: "redirect"; locale: Locale; location: string };

export function isHomePath(pathname: string): boolean {
  return pathname === "/" || PREFIXED_LOCALES.some((l) => pathname === `/${l}`);
}

/**
 * Pure locale-routing decision, shared by the Next proxy and the Astro
 * middleware so both stacks route visitors identically during the migration.
 */
export function decideLocale(req: LocaleRequest): LocaleDecision {
  const { pathname } = req;
  const isHome = isHomePath(pathname);

  if (isHome) {
    const wantsMarkdown = req.mode === "agent" || (req.accept ?? "").includes("text/markdown");
    if (wantsMarkdown) return { kind: "markdown" };
  }

  if (pathname === `/${DEFAULT_LOCALE}` || pathname.startsWith(`/${DEFAULT_LOCALE}/`)) {
    return { kind: "render", locale: DEFAULT_LOCALE, isHome: false, prefixed: true, explicitDefault: true };
  }

  const pathLocale = PREFIXED_LOCALES.find((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`));
  if (pathLocale) {
    return { kind: "render", locale: pathLocale, isHome, prefixed: true, explicitDefault: false };
  }

  const desired = isLocale(req.cookieLocale)
    ? req.cookieLocale
    : (topSupportedLanguage(req.acceptLanguage) ?? DEFAULT_LOCALE);

  if (desired !== DEFAULT_LOCALE) {
    return {
      kind: "redirect",
      locale: desired,
      location: pathname === "/" ? `/${desired}` : `/${desired}${pathname}`,
    };
  }

  return { kind: "render", locale: DEFAULT_LOCALE, isHome, prefixed: false, explicitDefault: false };
}
