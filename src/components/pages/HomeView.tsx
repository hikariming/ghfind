import type { ReactNode } from "react";
import { HomeFaq, type FaqItem } from "@/components/HomeFaq";
import { HomeHiring } from "@/components/HomeHiring";
import { HomeProjectBoards } from "@/components/HomeProjectBoards";
import { JsonLd, faqJsonLd } from "@/components/JsonLd";
import type { ProjectAssessment } from "@/lib/project-analysis-db";
import type { Translator } from "@/lib/translator";

/**
 * The homepage, shared by the Next app and apps/web (see BlogViews). The
 * interactive pieces arrive as slots: the Next page passes the components,
 * the Astro page passes independently hydrated islands, so only those pieces
 * ship JS while the rest (project cards, FAQ, footer) stays static HTML.
 */
export function HomeView({
  locale,
  t,
  tFaq,
  tBoards,
  faq,
  projectEntries,
  roaster,
  developerCount,
  sponsorRow,
  collections,
  leaderboardRail,
}: {
  locale: string;
  /** "home" namespace. */
  t: Translator;
  /** "faq" namespace. */
  tFaq: Translator;
  /** "projectBoards" namespace. */
  tBoards: Translator;
  faq: FaqItem[];
  projectEntries: ProjectAssessment[];
  roaster: ReactNode;
  developerCount: ReactNode;
  sponsorRow: ReactNode;
  collections: ReactNode;
  leaderboardRail: ReactNode;
}) {
  return (
    <main className="home-page flex flex-1 flex-col items-center px-5 pb-14 pt-2 sm:px-6 sm:pb-20 sm:pt-3">
      <JsonLd data={faqJsonLd(faq)} />
      <section className="home-intro">
        <header className="mb-7 flex w-full flex-col items-center text-center">
          <h1 className="home-title max-w-3xl text-balance">
            {t("headline")}
          </h1>
          <p className="home-description mt-4 max-w-xl text-sm sm:text-base">
            {t("subtitle")}
          </p>
        </header>
        {roaster}
        <div className="home-proof">
          {developerCount}
        </div>
        {sponsorRow}
      </section>

      {/* Content zone: directory-style two-column layout on desktop — main
          stream (hiring, editor's picks, project feed slot) with a sticky right rail
          (leaderboard teaser + discover links). Mobile folds to a single
          column, main content first. Pattern mirrors /u/[username]. */}
      <div className="home-content flex w-full max-w-6xl flex-col gap-10 lg:flex-row lg:items-start lg:gap-8">
        <div className="flex min-w-0 flex-1 flex-col gap-12">
          <HomeHiring locale={locale} t={t} />
          {collections}
          <HomeProjectBoards locale={locale} t={tBoards} entries={projectEntries} />
        </div>
        <aside className="flex w-full flex-col gap-6 lg:sticky lg:top-20 lg:w-80 lg:shrink-0">
          {leaderboardRail}
        </aside>
      </div>

      <HomeFaq items={faq} t={tFaq} />

      <footer className="mt-20 max-w-xl text-center text-xs leading-relaxed text-zinc-600">
        <p>{t.rich("disclaimer1", { b: (c) => <strong>{c}</strong> })}</p>
        <p className="mt-2">
          {t.rich("disclaimer2", {
            code: (c) => <code className="text-zinc-400">{c}</code>,
            skill: (c) => (
              <a
                href="https://github.com/hikariming/ghfind"
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-400 underline underline-offset-2 hover:text-orange-400"
              >
                <code>{c}</code>
              </a>
            ),
          })}
        </p>
        <p className="mt-2">
          <a href="https://ghfind.com" className="font-bold text-orange-400 hover:text-orange-300">
            ghfind.com
          </a>
        </p>
      </footer>
    </main>
  );
}
