"use client";

import { useTranslations } from "next-intl";
import { SponsorMark } from "@/components/SponsorMark";
import { useSponsorRecords } from "@/components/SponsorData";

/** Compact sponsor credit for pages that need a standalone sponsor pill. */
export function SponsorPill({ large = false }: { large?: boolean }) {
  const t = useTranslations("sponsor");
  const sponsors = useSponsorRecords();
  const sponsor = sponsors?.find((item) => item.tier === "夯");
  if (!sponsor) return null;
  const name = sponsor.isAnonymous ? t("anonymous") : sponsor.name;
  const contents = (
    <>
      <SponsorMark holder={sponsor} className={large ? "h-6 w-6 rounded" : "h-4 w-4 rounded"} />
      <span className="text-zinc-500">Powered by</span>
      <span className="font-semibold text-zinc-200">{name}</span>
    </>
  );
  const className = `inline-flex items-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition-colors hover:bg-white/10 ${large ? "gap-3 px-5 py-3 text-lg" : "gap-2 px-3 py-2 text-xs"}`;

  return sponsor.url ? (
    <a href={sponsor.url} target="_blank" rel="noopener noreferrer sponsored" className={className}>{contents}</a>
  ) : (
    <span className={className}>{contents}</span>
  );
}

/** Sponsor strip at the top of the navbar, populated from the public API. */
export function SponsorStrip() {
  const t = useTranslations("sponsor");
  const sponsors = useSponsorRecords();
  const sponsor = sponsors?.find((item) => item.tier === "夯");
  if (!sponsor) return null;

  const contents = (
    <>
      <span className="text-zinc-500">赞助商</span>
      <SponsorMark holder={sponsor} className="h-4 w-4 rounded" />
      <span className="font-semibold text-zinc-200">{sponsor.isAnonymous ? t("anonymous") : sponsor.name}</span>
      {sponsor.description && <span className="text-zinc-500">{sponsor.description}</span>}
      <span className="text-blue-500">了解更多 →</span>
    </>
  );
  const className = "inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200";

  return (
    <div className="sponsor-strip flex w-full items-center justify-center border-b border-white/10 bg-white/[0.03] px-4 py-1.5">
      {sponsor.url ? (
        <a href={sponsor.url} target="_blank" rel="noopener noreferrer sponsored" className={className}>{contents}</a>
      ) : (
        <span className={className}>{contents}</span>
      )}
    </div>
  );
}

/** Tiny one-line credit for the global footer. */
export function PoweredByLobeHub() {
  const t = useTranslations("sponsor");
  const sponsors = useSponsorRecords();
  const sponsor = sponsors?.find((item) => item.tier === "夯");
  if (!sponsor) return null;
  const contents = (
    <>
      <SponsorMark holder={sponsor} className="h-4 w-4 rounded" />
      Powered by {sponsor.isAnonymous ? t("anonymous") : sponsor.name}
    </>
  );
  const className = "inline-flex items-center gap-1.5 text-xs text-zinc-600 transition-colors hover:text-zinc-400";

  return sponsor.url ? (
    <a href={sponsor.url} target="_blank" rel="noopener noreferrer sponsored" className={className}>{contents}</a>
  ) : (
    <span className={className}>{contents}</span>
  );
}
