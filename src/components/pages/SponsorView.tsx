import { Check, HandHeart, Heart, Mail, ShieldCheck } from "lucide-react";
import { SPONSOR_CONTACT_EMAIL, SPONSOR_TIERS } from "@/config/sponsors";
import { SponsorHolders } from "@/components/SponsorHolders";
import styles from "@/app/[locale]/sponsor/sponsor.module.css";
import type { Translator } from "@/lib/translator";

type Perk = { text: string; soon?: boolean };

/** Plain `$` in every locale — Intl renders `US$` for zh, which reads noisy on a price tag. */
const usd = (amount: number) => `$${amount}`;

/** Body of the /sponsor page, shared by the Next app and apps/web (see BlogViews). */
export function SponsorView({ t }: { t: Translator }) {
  const mailto = (tier: string) => {
    const subject = t("emailTemplateSubject", { tier });
    const body = t("emailTemplateBody", { tier }).replace(/\r?\n/g, "\r\n");
    return `mailto:${SPONSOR_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

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
          const listPrice = tier.listPrice && tier.listPrice > tier.price ? tier.listPrice : null;
          return (
            <article key={tier.id} className={styles.card} data-tier={tier.displayTier} data-sold-out={tier.soldOut || undefined}>
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
                {listPrice && (
                  <>
                    <s aria-label={t("listPrice", { price: usd(listPrice) })}>{usd(listPrice)}</s>
                    <em>{t("off", { off: Math.round((1 - tier.price / listPrice) * 100) })}</em>
                  </>
                )}
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
                <SponsorHolders
                  tier={tier.displayTier}
                  wrapperClassName={styles.holders}
                  className={styles.holder}
                  logoClassName={styles.holderLogo}
                  anonymousLabel={t("anonymous")}
                  label={t("currentHolder")}
                  empty={{
                    className: styles.slotOpen,
                    text: t("slotOpen"),
                    href: tier.soldOut ? undefined : mailto(t(`tiers.${tier.id}.name`)),
                  }}
                  scroll
                />
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
        <SponsorHolders
          tier="友情"
          wrapperClassName={styles.friendWall}
          className={styles.holder}
          logoClassName={styles.holderLogo}
          anonymousLabel={t("anonymous")}
          empty={{
            className: styles.friendEmpty,
            text: t("friends.empty"),
            href: mailto(t("tiers.friend.name")),
          }}
        />
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
