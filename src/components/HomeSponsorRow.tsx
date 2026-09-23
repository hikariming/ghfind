import { getTranslations } from "next-intl/server";
import { Plus } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { HOME_SPONSOR_SLOTS, SPONSOR_TIERS } from "@/config/sponsors";
import { SponsorMark } from "./SponsorMark";

/**
 * Homepage sponsor row under the scan form — the Featured-tier slot. Filled
 * cells link out with a one-line tagline; the rest advertise the tier via
 * /sponsor.
 */
export async function HomeSponsorRow() {
  const t = await getTranslations("sponsor");
  const tier = SPONSOR_TIERS.find(item => item.id === "featured");
  if (!tier) return null;
  const holders = tier.holders.slice(0, HOME_SPONSOR_SLOTS);
  const open = HOME_SPONSOR_SLOTS - holders.length;

  return (
    <section className="home-sponsors" aria-label={t("rowLabel")}>
      <div className="home-sponsors-grid">
        {holders.map(holder => (
          <a key={holder.name} href={holder.url} target="_blank" rel="noopener noreferrer sponsored" className="home-sponsor-cell">
            <SponsorMark holder={holder} className="home-sponsor-logo" />
            <span className="home-sponsor-text">
              <strong>{holder.name}</strong>
              {holder.id && t.has(`holders.${holder.id}`) && <span>{t(`holders.${holder.id}`)}</span>}
            </span>
          </a>
        ))}
        {Array.from({ length: open }, (_, i) => (
          <Link key={i} href="/sponsor" prefetch={false} className="home-sponsor-cell home-sponsor-open" data-first={i === 0 || undefined}>
            <span className="home-sponsor-plus"><Plus size={14} aria-hidden /></span>
            <span className="home-sponsor-text"><strong>{t("slotOpen")}</strong></span>
          </Link>
        ))}
      </div>
    </section>
  );
}
