/**
 * Sponsor credit — LobeHub (first sponsor of the project).
 *
 * Brand constants centralized here so wording/links/logo change in one place
 * (and translate cleanly later). Deliberately understated: neutral card style,
 * muted text, no banner/gradient.
 */

const SPONSOR = {
  name: "LobeHub",
  url: "https://lobehub.com",
  logo: "/lobehub.png",
  poweredBy: "Powered by LobeHub",
};

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
      <span className="font-semibold text-zinc-200">LobeHub</span>
    </a>
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
      {SPONSOR.poweredBy}
    </a>
  );
}
