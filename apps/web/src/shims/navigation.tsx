/**
 * `@/i18n/navigation` shim for Astro islands. The Next version wraps
 * next-intl's `createNavigation`; here links are plain anchors (Astro pages are
 * MPA, and legacy pages live on another Worker anyway) and router calls are
 * full navigations.
 */
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { localePath, type Locale } from "@ghfind/i18n";
import { useRoute } from "./route-context";

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  locale?: Locale;
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
};

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  // Next-only props are accepted and dropped so shared components compile.
  { href, locale, prefetch: _prefetch, scroll: _scroll, replace: _replace, ...rest },
  ref,
) {
  const route = useRoute();
  const target = href.startsWith("/") ? localePath(locale ?? route.locale, href) : href;
  return <a ref={ref} href={target} {...rest} />;
});

export function usePathname(): string {
  return useRoute().pathname;
}

type NavigateOptions = { locale?: Locale; scroll?: boolean };

export function useRouter() {
  const route = useRoute();
  const resolve = (href: string, options?: NavigateOptions) =>
    href.startsWith("/") ? localePath(options?.locale ?? route.locale, href) : href;
  return {
    push: (href: string, options?: NavigateOptions) => window.location.assign(resolve(href, options)),
    replace: (href: string, options?: NavigateOptions) => window.location.replace(resolve(href, options)),
    refresh: () => window.location.reload(),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    prefetch: () => {},
  };
}

export function getPathname({ href, locale }: { href: string; locale: Locale }): string {
  return localePath(locale, href);
}

export function redirect(): never {
  throw new Error("redirect() is server-only; use Astro.redirect in pages");
}
