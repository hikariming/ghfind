import type { ReactNode } from "react";

/**
 * Shared horizontal snap-scroll strip for homepage content bands: visible
 * thin scrollbar (webkit + standard properties) and edge fades painted from
 * the theme-aware --color-background so clipped cards dissolve into the page
 * in both light and dark themes. Children must be fixed-width snap items.
 */
export function HomeSnapStrip({ children }: { children: ReactNode }) {
  return (
    <div className="relative -mx-5 mt-5 sm:-mx-6">
      <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-3 [scrollbar-color:var(--color-zinc-500)_transparent] [scrollbar-width:thin] sm:px-6 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-500/50 [&::-webkit-scrollbar-track]:bg-transparent">
        {children}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-5 bg-gradient-to-r from-background to-transparent sm:w-6"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent sm:w-12"
      />
    </div>
  );
}
