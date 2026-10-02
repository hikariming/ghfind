/**
 * `next/navigation` shim for islands and shared code. Astro pages are MPA:
 * router calls become full navigations, search params come from the URL
 * (the route context during SSR, `window.location` in the browser).
 */
import { useRoute } from "./route-context";
import { useRouter as useLocaleRouter } from "./navigation";

export { usePathname } from "./navigation";

export function useRouter() {
  // next/navigation's router takes already-localized hrefs.
  const router = useLocaleRouter();
  return {
    ...router,
    push: (href: string) => window.location.assign(href),
    replace: (href: string) => window.location.replace(href),
  };
}

export function useSearchParams(): URLSearchParams {
  const route = useRoute();
  if (typeof window !== "undefined") return new URLSearchParams(window.location.search);
  return new URLSearchParams(route.search ?? "");
}

export function useParams(): Record<string, string> {
  return useRoute().params ?? {};
}

export function notFound(): never {
  throw new Error("notFound() is server-only; Astro pages return notFound() from lib/not-found");
}

export function redirect(): never {
  throw new Error("redirect() is server-only; Astro pages use Astro.redirect");
}
