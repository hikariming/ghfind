import { getTranslations, setRequestLocale } from "next-intl/server";
import { DeveloperCount } from "@/components/DeveloperCount";
import { HomeCollections } from "@/components/HomeCollections";
import { HomeProjectBoards } from "@/components/HomeProjectBoards";
import { LeaderboardRail } from "@/components/LeaderboardRail";
import { Roaster } from "@/components/Roaster";
import { HomeFaq, getFaqItems } from "@/components/HomeFaq";
import { JsonLd, faqJsonLd } from "@/components/JsonLd";
// ISR: the homepage shell is fully static (the scan form, tier pills and copy are
// locale-only; DeveloperCount and the leaderboard rail fetch client-side from
// the API; the projects preview reads build-embedded content files). Serving it
// from the CDN instead of rendering a function on every visit is what frees
// the serverless pool for the LLM scan/roast traffic.
// Keep the durable snapshot for an hour: minute-level regeneration only creates
// repeated ISR writes.
// Pin the homepage to static + ISR. Next 16's "auto" heuristic otherwise renders
// it on demand (a function per visit); forcing static serves the shell from the
// CDN. This is the change that takes the bulk of homepage traffic off the
// serverless pool.
export const dynamic = "force-static";
export const revalidate = 3600;

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const faqItems = await getFaqItems();

  return (
    <main className="home-page flex flex-1 flex-col items-center px-5 pb-14 pt-2 sm:px-6 sm:pb-20 sm:pt-3">
      <JsonLd data={faqJsonLd(faqItems)} />
      <section className="home-intro">
        <header className="mb-7 flex w-full flex-col items-center text-center">
          <h1 className="home-title max-w-3xl text-balance">
            {t("headline")}
          </h1>
          <p className="home-description mt-4 max-w-xl text-sm sm:text-base">
            {t("subtitle")}
          </p>
        </header>
        <Roaster />
        <div className="home-proof">
          <DeveloperCount />
        </div>
      </section>

      {/* Content zone: directory-style two-column layout on desktop — main
          stream (editor's picks + project feed slot) with a sticky right rail
          (leaderboard teaser + discover links). Mobile folds to a single
          column, main content first. Pattern mirrors /u/[username]. */}
      <div className="home-content flex w-full max-w-6xl flex-col gap-10 lg:flex-row lg:items-start lg:gap-8">
        <div className="flex min-w-0 flex-1 flex-col gap-12">
          <HomeCollections locale={locale} />
          <HomeProjectBoards locale={locale} />
        </div>
        <aside className="flex w-full flex-col gap-6 lg:sticky lg:top-20 lg:w-80 lg:shrink-0">
          <LeaderboardRail />
        </aside>
      </div>

      <HomeFaq items={faqItems} />

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
