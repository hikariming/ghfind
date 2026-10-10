import { getTranslations, setRequestLocale } from "next-intl/server";
import { DeveloperCount } from "@/components/DeveloperCount";
import { HomeCollections } from "@/components/HomeCollections";
import { loadHomeCollectionCards } from "@/lib/pages/home";
import { faqItems } from "@/components/HomeFaq";
import { loadHomeProjectEntries } from "@/components/HomeProjectBoards";
import { HomeSponsorRow } from "@/components/HomeSponsorRow";
import { LeaderboardRail } from "@/components/LeaderboardRail";
import { Roaster } from "@/components/Roaster";
import { HomeView } from "@/components/pages/HomeView";
import { listJobs } from "@/lib/jobs";
import { asTranslator } from "@/lib/translator";
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
  const [t, tFaq, tBoards, tCollections, tBlog, tJobs, cards, projectEntries, jobs] = await Promise.all([
    getTranslations("home"),
    getTranslations("faq"),
    getTranslations("projectBoards"),
    getTranslations("collections"),
    getTranslations("blog"),
    getTranslations("jobs"),
    loadHomeCollectionCards(locale),
    loadHomeProjectEntries(),
    listJobs(locale, { limit: 4 }),
  ]);

  return (
    <HomeView
      locale={locale}
      t={asTranslator(t)}
      tFaq={asTranslator(tFaq)}
      tBoards={asTranslator(tBoards)}
      tJobs={asTranslator(tJobs)}
      jobs={jobs}
      faq={faqItems(asTranslator(tFaq))}
      projectEntries={projectEntries}
      roaster={<Roaster />}
      developerCount={<DeveloperCount />}
      sponsorRow={<HomeSponsorRow />}
      collections={<HomeCollections locale={locale} cards={cards} t={asTranslator(tCollections)} tBlog={asTranslator(tBlog)} />}
      leaderboardRail={<LeaderboardRail />}
    />
  );
}
