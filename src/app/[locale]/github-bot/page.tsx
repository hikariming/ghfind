import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowUpRight, AtSign, Download, LayoutDashboard, LockKeyhole, Power, Search, Tag } from "lucide-react";
import { localeAlternates } from "@/lib/site";
import styles from "./github-bot.module.css";

export const dynamic = "force-static";

const INSTALL_URL = "https://github.com/apps/ghfind-review/installations/new";
const STATUS_URL = "https://bot.ghfind.com";
const PRIVACY_URL = "https://bot.ghfind.com/privacy";
const SOURCE_URL = "https://github.com/hikariming/ghfind/tree/main/platform/github-app";

/** Mirrors `platform/github-app` label definitions — GitHub renders these hexes as-is in both themes. */
const LABELS = [
  { id: "low", name: "review: low", color: "#d9dee3" },
  { id: "medium", name: "review: medium", color: "#b6dfff" },
  { id: "high", name: "review: high", color: "#e2c0a2" },
  { id: "top", name: "review: top", color: "#ded0a6" },
  { id: "noScore", name: "review: no-score", color: "#c3c7ce" },
] as const;

const QUEUES = [
  { id: "high", filter: 'is:open is:issue label:"review: high"' },
  { id: "top", filter: 'is:open is:issue label:"review: top"' },
  { id: "low", filter: 'is:open is:issue label:"review: low"' },
  { id: "noScore", filter: 'is:open is:issue label:"review: no-score"' },
] as const;

const STEPS = [
  { id: "install", icon: Download },
  { id: "open", icon: Tag },
  { id: "label", icon: LayoutDashboard },
] as const;

const NOTES = [
  { id: "rescore", icon: AtSign },
  { id: "privacy", icon: LockKeyhole },
  { id: "stop", icon: Power },
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "githubBot" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/github-bot"),
  };
}

export default async function GithubBotPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("githubBot");

  return (
    <main className={styles.page}>
      <div className={styles.topline}>
        <span>
          {t("topline.section")} <span className={styles.slash}>/</span> <strong>{t("topline.current")}</strong>
        </span>
      </div>

      <section className={styles.hero}>
        <div className={styles.heroText}>
          <span className={styles.eyebrow}>{t("hero.eyebrow")}</span>
          <h1>{t("hero.title")}</h1>
          <p>{t("hero.subtitle")}</p>
          <div className={styles.actions}>
            <a className={styles.cta} href={INSTALL_URL} target="_blank" rel="noopener noreferrer">
              {t("hero.install")} <ArrowUpRight size={14} aria-hidden />
            </a>
            <a className={styles.secondary} href={STATUS_URL} target="_blank" rel="noopener noreferrer">
              {t("hero.status")}
            </a>
          </div>
          <p className={styles.heroNote}>{t("hero.note")}</p>
        </div>

        <figure className={styles.preview} aria-label={t("preview.label")}>
          <div className={styles.previewHead}>
            <span>{t("preview.heading")}</span>
          </div>
          {(["top", "medium", "noScore"] as const).map(id => {
            const label = LABELS.find(item => item.id === id)!;
            return (
              <div key={id} className={styles.previewRow}>
                <span className={styles.previewDot} aria-hidden />
                <div>
                  <span className={styles.previewTitle}>{t(`preview.items.${id}`)}</span>
                  <span className={styles.previewMeta}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/github-bot/avatar.png" alt="" width={14} height={14} />
                    ghfind-review[bot]
                    <span className={styles.label} style={{ backgroundColor: label.color }}>{label.name}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </figure>
      </section>

      <section className={styles.section}>
        <h2>{t("labels.heading")}</h2>
        <p className={styles.lead}>{t("labels.lead")}</p>
        <div className={styles.labelGrid}>
          {LABELS.map(label => (
            <div key={label.id} className={styles.labelCard}>
              <span className={styles.label} style={{ backgroundColor: label.color }}>{label.name}</span>
              <strong>{t(`labels.items.${label.id}.range`)}</strong>
              <p>{t(`labels.items.${label.id}.desc`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>{t("steps.heading")}</h2>
        <ol className={styles.steps}>
          {STEPS.map(({ id, icon: Icon }, index) => (
            <li key={id}>
              <div className={styles.stepHead}>
                <span className={styles.stepIndex}>{String(index + 1).padStart(2, "0")}</span>
                <Icon size={16} strokeWidth={1.7} aria-hidden />
              </div>
              <h3>{t(`steps.items.${id}.title`)}</h3>
              <p>{t(`steps.items.${id}.body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section}>
        <h2>{t("queues.heading")}</h2>
        <p className={styles.lead}>{t("queues.lead")}</p>
        <div className={styles.queues}>
          {QUEUES.map(queue => (
            <div key={queue.id} className={styles.queue}>
              <span>{t(`queues.items.${queue.id}`)}</span>
              <code><Search size={12} aria-hidden />{queue.filter}</code>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.notes}>
        {NOTES.map(({ id, icon: Icon }) => (
          <article key={id} className={styles.note}>
            <Icon size={18} strokeWidth={1.7} aria-hidden />
            <h3>{t(`notes.${id}.heading`)}</h3>
            <p>{t(`notes.${id}.body`)}</p>
            {id === "privacy" && (
              <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
                {t("notes.privacy.link")} <ArrowUpRight size={12} aria-hidden />
              </a>
            )}
          </article>
        ))}
      </section>

      <p className={styles.disclaimer}>{t("disclaimer")}</p>
      <p className={styles.source}>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{t("source")}</a>
      </p>
    </main>
  );
}
