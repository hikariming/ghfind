import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Check, HandHeart, Heart, Mail, ShieldCheck } from "lucide-react";
import { FRIEND_SPONSORS, SPONSOR_CONTACT_EMAIL, SPONSOR_TIERS, type SponsorHolder } from "@/config/sponsors";
import { SponsorMark } from "@/components/SponsorMark";
import { localeAlternates } from "@/lib/site";
import styles from "./sponsor.module.css";

export const dynamic = "force-static";

type Perk = { text: string; soon?: boolean };

/** Plain `$` in every locale — Intl renders `US$` for zh, which reads noisy on a price tag. */
const usd = (amount: number) => `$${amount}`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "sponsor" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/sponsor"),
  };
}

function HolderLink({ holder }: { holder: SponsorHolder }) {
  return (
    <a href={holder.url} target="_blank" rel="noopener noreferrer sponsored" className={styles.holder}>
      <SponsorMark holder={holder} className={styles.holderLogo} />
      <span>{holder.name}</span>
    </a>
  );
}

export default async function SponsorPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("sponsor");
  const mailto = (tier: string) =>
    `mailto:${SPONSOR_CONTACT_EMAIL}?subject=${encodeURIComponent(`ghfind sponsor · ${tier}`)}`;

  return (
    <main className={styles.page}>
      <div className={styles.topline}>
        <span>
          {t("topline.section")} <span className={styles.slash}>/</span> <strong>{t("topline.current")}</strong>
        </span>
      </div>

      <section className={styles.hero}>
        <h1>
          {t("hero.titleLead")}
          <br />
          <span>{t("hero.titleAccent")}</span>
          <Heart className={styles.heroHeart} strokeWidth={1.6} aria-hidden />
        </h1>
        <p>{t("hero.subtitle")}</p>
      </section>

      <div className={styles.grid}>
        {SPONSOR_TIERS.map((tier, index) => {
          const perks = t.raw(`tiers.${tier.id}.perks`) as Perk[];
          const off = Math.round((1 - tier.price / tier.listPrice) * 100);
          return (
            <article key={tier.id} className={styles.card} data-tier={tier.id} data-sold-out={tier.soldOut || undefined}>
              <div className={styles.cardTop}>
                <span className={styles.eyebrow}>{String(index + 1).padStart(2, "0")}</span>
                {tier.soldOut
                  ? <span className={styles.soldOut}>{t("soldOut")}</span>
                  : <span className={styles.available}>{t("available")}</span>}
              </div>
              <h2>{t(`tiers.${tier.id}.name`)}</h2>
              <p className={styles.summary}>{t(`tiers.${tier.id}.summary`)}</p>

              <div className={styles.price}>
                <strong>{usd(tier.price)}</strong>
                <span>{t("perMonth")}</span>
                <s aria-label={t("listPrice", { price: usd(tier.listPrice) })}>{usd(tier.listPrice)}</s>
                <em>{t("off", { off })}</em>
              </div>

              <ul className={styles.perks}>
                {perks.map(perk => (
                  <li key={perk.text}>
                    <Check size={14} strokeWidth={2} aria-hidden />
                    <span>{perk.text}{perk.soon && <span className={styles.soon}>{t("soon")}</span>}</span>
                  </li>
                ))}
              </ul>

              <div className={styles.cardFooter}>
                {tier.holders.length > 0 && (
                  <div className={styles.holders}>
                    <span>{t("currentHolder")}</span>
                    {tier.holders.map(holder => <HolderLink key={holder.name} holder={holder} />)}
                  </div>
                )}
                {tier.soldOut
                  ? <span className={styles.ctaDisabled} aria-disabled="true">{t("ctaSoldOut")}</span>
                  : <a className={styles.cta} href={mailto(t(`tiers.${tier.id}.name`))}><Mail size={14} aria-hidden /> {t("cta")}</a>}
              </div>
            </article>
          );
        })}
      </div>

      <section className={styles.friends}>
        <div className={styles.sectionHead}>
          <HandHeart size={18} strokeWidth={1.7} aria-hidden />
          <h2>{t("friends.heading")}</h2>
        </div>
        <p>{t("friends.lead")}</p>
        {FRIEND_SPONSORS.length > 0 ? (
          <div className={styles.friendWall}>
            {FRIEND_SPONSORS.map(holder => <HolderLink key={holder.name} holder={holder} />)}
          </div>
        ) : (
          <a className={styles.friendEmpty} href={mailto(t("tiers.friend.name"))}>{t("friends.empty")}</a>
        )}
      </section>

      <section className={styles.fairness}>
        <ShieldCheck size={22} strokeWidth={1.7} aria-hidden />
        <div>
          <h2>{t("fairness.heading")}</h2>
          <p>{t("fairness.body")}</p>
        </div>
      </section>

      <p className={styles.contact}>
        {t("contactLead")}{" "}
        <a href={`mailto:${SPONSOR_CONTACT_EMAIL}`}>{SPONSOR_CONTACT_EMAIL}</a>
      </p>
    </main>
  );
}
