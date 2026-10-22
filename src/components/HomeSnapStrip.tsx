import type { ReactNode } from "react";

/**
 * Shared horizontal snap-scroll strip for homepage content bands: visible
 * thin scrollbar (webkit + standard properties) and edge fades painted from
 * the theme-aware --color-background so clipped cards dissolve into the page
 * in both light and dark themes. Children must be fixed-width snap items.
 *
 * Bleed uses -mx-5 below 900px and -mx-6 from 900px so it stays inside
 * workspace home-page padding (22px / clamp(24px, 4vw, 64px)) and does not
 * extend the document. scroll-padding-inline matches the scroller padding so
 * snap-mandatory keeps the first card in the padded start position instead of
 * pulling it under the left fade.
 */
export function HomeSnapStrip({ children }: { children: ReactNode }) {
  return (
    <div className="home-snap-strip relative mt-5 -mx-5 min-[900px]:-mx-6">
      <div className="home-snap-scroller flex items-stretch snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-5 px-5 pb-3 min-[900px]:scroll-px-6 min-[900px]:px-6 [scrollbar-color:var(--color-zinc-500)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-500/50 [&::-webkit-scrollbar-track]:bg-transparent">
        {children}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-5 bg-gradient-to-r from-background to-transparent min-[900px]:w-6"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent min-[900px]:w-12"
      />
    </div>
  );
}
