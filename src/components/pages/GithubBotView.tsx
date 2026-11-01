import { ArrowRight, ArrowUpRight, ChevronDown, History, LayoutDashboard, ListTodo, Settings2, Tag, Terminal } from "lucide-react";
import styles from "@/app/[locale]/github-bot/github-bot.module.css";
import type { Translator } from "@/lib/translator";

const INSTALL_URL = "https://github.com/apps/ghfind-review/installations/new";
const BOT_URL = "https://bot.ghfind.com";
const SOURCE_URL = "https://github.com/hikariming/ghfind/tree/main/platform/github-app";

/** GitHub label colors are intentionally the same in both resolved themes. */
const LABELS = [
  { id: "low", name: "review: low", color: "#d9dee3" },
  { id: "medium", name: "review: medium", color: "#b6dfff" },
  { id: "high", name: "review: high", color: "#e2c0a2" },
  { id: "top", name: "review: top", color: "#ded0a6" },
  { id: "noScore", name: "review: no-score", color: "#c3c7ce" },
] as const;
const ADMIN_PAGES = [
  { id: "overview", path: "/admin", icon: LayoutDashboard },
  { id: "repositories", path: "/admin/repositories", icon: Settings2 },
  { id: "tasks", path: "/admin/tasks", icon: ListTodo },
  { id: "activity", path: "/admin/activity", icon: History },
] as const;
const OPERATIONS = ["preview", "backfill", "cleanup"] as const;
const AI_OPTIONS = ["provider", "protocol", "key", "test"] as const;
const QUEUES = [
  { id: "high", filter: 'is:open is:issue label:"review: high"' },
  { id: "top", filter: 'is:open is:issue label:"review: top"' },
  { id: "low", filter: 'is:open is:issue label:"review: low"' },
  { id: "noScore", filter: 'is:open is:issue label:"review: no-score"' },
] as const;

/** Shared, server-rendered product page for Next and Astro. */
export function GithubBotView({ locale, t }: { locale: string; t: Translator }) {
  const botLink = (path: string) => `${BOT_URL}${path}?lang=${encodeURIComponent(locale)}`;
  return (
    <main className={styles.page}>
      <div className={styles.topline}>
        <span>{t("topline.section")}</span><span aria-hidden>/</span><strong>{t("topline.current")}</strong>
      </div>
      <section className={styles.hero} aria-labelledby="bot-heading">
        <div className={styles.heroText}>
          <p className={styles.eyebrow}>{t("hero.eyebrow")}</p>
          <h1 id="bot-heading">{t("hero.title")}</h1>
          <p className={styles.subtitle}>{t("hero.subtitle")}</p>
          <div className={styles.actions}>
            <a className={styles.cta} href={botLink("/admin")}>
              {t("hero.admin")} <ArrowRight size={17} aria-hidden />
            </a>
            <a className={styles.secondary} href={INSTALL_URL} target="_blank" rel="noopener noreferrer">
              {t("hero.install")} <ArrowUpRight size={16} aria-hidden />
            </a>
          </div>
        </div>
        <nav className={styles.console} aria-label={t("console.heading")}>
          <p className={styles.consoleHeading}>{t("console.heading")}</p>
          {ADMIN_PAGES.map(({ id, path, icon: Icon }) => (
            <a key={id} href={botLink(path)} className={styles.consoleLink}>
              <Icon size={20} strokeWidth={1.6} aria-hidden />
              <span><strong>{t(`console.items.${id}.title`)}</strong><span>{t(`console.items.${id}.body`)}</span></span>
              <ArrowRight size={16} aria-hidden />
            </a>
          ))}
          <p className={styles.consoleNote}>{t("console.note")}</p>
        </nav>
      </section>
      <figure className={styles.consolePreview}>
        {(["light", "dark"] as const).map(theme => (
          // Actual local dashboard captures, explicitly marked as demo data.
          // eslint-disable-next-line @next/next/no-img-element
          <img key={theme} className={styles[`${theme}Preview`]} src={`/github-bot/console-${locale === "zh" ? "zh" : "en"}-${theme}.jpg`}
            alt={t("console.screenshotAlt")} width={1280} height={820} loading="lazy" decoding="async" />
        ))}
        <figcaption>{t("console.preview")}</figcaption>
      </figure>
      <section className={styles.section} aria-labelledby="classification-heading">
        <div className={styles.sectionHeading}>
          <h2 id="classification-heading">{t("classification.heading")}</h2><p>{t("classification.lead")}</p>
        </div>
        <div className={styles.classification}>
          {(["score", "intent"] as const).map(id => (
            <article key={id}>
              <p className={styles.featureMode}>{t(`classification.${id}.mode`)}</p>
              <h3>{t(`classification.${id}.title`)}</h3>
              <p>{t(`classification.${id}.body`)}</p>
              <p className={styles.featureExample}>{t(`classification.${id}.example`)}</p>
            </article>
          ))}
        </div>
      </section>
      <section className={styles.section} aria-labelledby="byok-heading">
        <div className={styles.byok}>
          <div className={styles.sectionHeading}>
            <h2 id="byok-heading">{t("byok.heading")}</h2>
            <p>{t("byok.lead")}</p>
            <div className={styles.actions}>
              <a className={styles.cta} href={botLink("/admin/repositories")}>
                {t("byok.cta")} <ArrowRight size={17} aria-hidden />
              </a>
            </div>
            <p className={styles.byokNote}>{t("byok.setup")}</p>
          </div>
          <dl className={styles.byokDetails}>
            {AI_OPTIONS.map(id => (
              <div key={id}>
                <dt>{t(`byok.items.${id}.title`)}</dt>
                <dd>{t(`byok.items.${id}.body`)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className={styles.byokBilling}>{t("byok.billing")}</p>
      </section>
      <section className={styles.section} aria-labelledby="operations-heading">
        <div className={styles.sectionHeading}>
          <h2 id="operations-heading">{t("operations.heading")}</h2><p>{t("operations.lead")}</p>
        </div>
        <dl className={styles.operations}>
          {OPERATIONS.map((id, index) => (
            <div key={id}>
              <dt><span className={styles.index} aria-hidden>{String(index + 1).padStart(2, "0")}</span>{t(`operations.items.${id}.title`)}</dt>
              <dd>{t(`operations.items.${id}.body`)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={styles.cli} aria-labelledby="cli-heading">
        <div>
          <Terminal size={22} strokeWidth={1.6} aria-hidden />
          <h2 id="cli-heading">{t("cli.heading")}</h2><p>{t("cli.body")}</p>
          <a href={`${SOURCE_URL}/README.md#cli-and-api-for-agents`} target="_blank" rel="noopener noreferrer">
            {t("cli.link")} <ArrowUpRight size={15} aria-hidden />
          </a>
        </div>
        <div className={styles.commands}>
          <span>{t("cli.example")}</span>
          <pre dir="ltr"><code>{"ghfind bot status owner/repo\nghfind bot backfill owner/repo -n 25\nghfind bot cleanup owner/repo --labels all"}</code></pre>
          <p>{t("cli.note")}</p>
        </div>
      </section>
      <details className={styles.reference}>
        <summary><Tag size={18} aria-hidden /><span>{t("reference.heading")}</span><ChevronDown size={18} aria-hidden /></summary>
        <div className={styles.referenceBody}>
          <h2>{t("labels.heading")}</h2><p className={styles.lead}>{t("labels.lead")}</p>
          <dl className={styles.labels}>
            {LABELS.map(label => (
              <div key={label.id}>
                <dt><span className={styles.label} style={{ backgroundColor: label.color }}>{label.name}</span></dt>
                <dd className={styles.range}>{t(`labels.items.${label.id}.range`)}</dd><dd>{t(`labels.items.${label.id}.desc`)}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.disclaimer}>{t("disclaimer")}</p>
          <h2>{t("queues.heading")}</h2><p className={styles.lead}>{t("queues.lead")}</p>
          <dl className={styles.queues}>
            {QUEUES.map(queue => (
              <div key={queue.id}><dt>{t(`queues.items.${queue.id}`)}</dt><dd><code>{queue.filter}</code></dd></div>
            ))}
          </dl>
        </div>
      </details>
      <section className={styles.notes} aria-label={t("notes.heading")}>
        {(["install", "privacy", "stop"] as const).map(id => (
          <article key={id}>
            <h2>{t(`notes.${id}.heading`)}</h2><p>{t(`notes.${id}.body`)}</p>
            {id === "privacy" && <a href={botLink("/privacy")}>{t("notes.privacy.link")} <ArrowRight size={14} aria-hidden /></a>}
          </article>
        ))}
      </section>
      <div className={styles.footerLinks}>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{t("source")} <ArrowUpRight size={14} aria-hidden /></a>
        <a href={botLink("/")}>{t("hero.status")} <ArrowRight size={14} aria-hidden /></a>
      </div>
    </main>
  );
}
