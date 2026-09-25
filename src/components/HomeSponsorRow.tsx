"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { SponsorMark } from "./SponsorMark";
import { useSponsorRecords } from "./SponsorData";
import { HOME_SPONSOR_SLOTS } from "@/config/sponsors";

/** Homepage sponsor row under the scan form, populated from the public API. */
export function HomeSponsorRow() {
  const t = useTranslations("sponsor");
  const sponsors = useSponsorRecords();
  const holders = (sponsors ?? []).filter((sponsor) => sponsor.tier === "人上人").slice(0, HOME_SPONSOR_SLOTS);
  const open = HOME_SPONSOR_SLOTS - holders.length;

  return (
    <section className="home-sponsors" aria-label={t("rowLabel")}>
      <div className="home-sponsors-grid">
        {holders.map((holder) => {
          const contents = (
            <>
              <SponsorMark holder={holder} className="home-sponsor-logo" />
              <span className="home-sponsor-text">
                <strong>{holder.isAnonymous ? t("anonymous") : holder.name}</strong>
                {holder.description && <span>{holder.description}</span>}
              </span>
            </>
          );
          return holder.url ? (
            <a key={holder.id} href={holder.url} target="_blank" rel="noopener noreferrer sponsored" className="home-sponsor-cell">
              {contents}
            </a>
          ) : (
            <div key={holder.id} className="home-sponsor-cell">{contents}</div>
          );
        })}
        {Array.from({ length: Math.max(0, open) }, (_, i) => (
          <Link key={i} href="/sponsor" prefetch={false} className="home-sponsor-cell home-sponsor-open" data-first={i === 0 || undefined}>
            <span className="home-sponsor-plus"><Plus size={14} aria-hidden /></span>
            <span className="home-sponsor-text"><strong>{t("slotOpen")}</strong></span>
          </Link>
        ))}
      </div>
    </section>
  );
}
