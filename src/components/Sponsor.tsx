/**
 * Sponsor credit — LobeHub (first sponsor of the project).
 *
 * Brand constants centralized here so wording/links/logo change in one place
 * (and translate cleanly later). Deliberately understated: neutral card style,
 * muted text, no banner/gradient.
 */

import { SPONSOR } from "@/lib/sponsor";

const poweredBy = `Powered by ${SPONSOR.name}`;

/** Sponsor pill. `large` bumps every dimension ~50% for a more prominent slot. */
export function SponsorPill({ large = false }: { large?: boolean }) {
  return (
    <a
      href={SPONSOR.url}
      target="_blank"
      rel="noopener noreferrer sponsored"
      className={`inline-flex items-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition-colors hover:bg-white/10 ${
        large ? "gap-3 px-5 py-3 text-lg" : "gap-2 px-3 py-2 text-xs"
      }`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={SPONSOR.logo}
        alt={SPONSOR.name}
        className={large ? "h-6 w-6 rounded" : "h-4 w-4 rounded"}
      />
      <span className="text-zinc-500">Powered by</span>
      <span className="font-semibold text-zinc-200">{SPONSOR.name}</span>
    </a>
  );
}

/**
 * Thin full-width strip rendered at the very top of the navbar. Replaces the
 * homepage-only sponsor pill so the credit is visible on every page without
 * eating hero real estate.
 */
export function SponsorStrip() {
  return (
    <div className="flex w-full items-center justify-center border-b border-white/10 bg-white/[0.03] px-4 py-1.5">
      <a
        href={SPONSOR.url}
        target="_blank"
        rel="noopener noreferrer sponsored"
        className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
      >
        <span className="text-zinc-500">赞助商</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={SPONSOR.logo} alt={SPONSOR.name} className="h-4 w-4 rounded" />
        <span className="font-semibold text-zinc-200">{SPONSOR.name}</span>
        <span className="text-zinc-500">{SPONSOR.tagline}</span>
        <span className="text-blue-500">了解更多 →</span>
      </a>
    </div>
  );
}

/** Tiny one-line credit for the global footer (every page). */
export function PoweredByLobeHub() {
  return (
    <a
      href={SPONSOR.url}
      target="_blank"
      rel="noopener noreferrer sponsored"
      className="inline-flex items-center gap-1.5 text-xs text-zinc-600 transition-colors hover:text-zinc-400"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={SPONSOR.logo} alt={SPONSOR.name} className="h-4 w-4 rounded" />
      {poweredBy}
    </a>
  );
}
