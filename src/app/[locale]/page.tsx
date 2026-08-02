import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { DeveloperCount } from "@/components/DeveloperCount";
import { HomeCollections } from "@/components/HomeCollections";
import { HomeProjectsPreview } from "@/components/HomeProjectsPreview";
import { LeaderboardRail } from "@/components/LeaderboardRail";
import { Roaster } from "@/components/Roaster";
import { HomeFaq, getFaqItems } from "@/components/HomeFaq";
import { HomeIntro } from "@/components/HomeIntro";
import { JsonLd, faqJsonLd } from "@/components/JsonLd";
import type { TierKey } from "@/lib/tier";

// ISR: the homepage shell is fully static (the scan form, tier pills and copy are
// locale-only; DeveloperCount fetches client-side; the leaderboard rail and
// projects preview read Redis-cached boards). Serving it from the CDN instead of
// rendering a function on every visit is what frees the serverless pool for the
// LLM scan/roast traffic.
// Keep the durable snapshot for an hour: minute-level regeneration only creates
// repeated ISR writes.
// Pin the homepage to static + ISR. Next 16's "auto" heuristic otherwise renders
// it on demand (a function per visit); forcing static serves the shell from the
// CDN. This is the change that takes the bulk of homepage traffic off the
// serverless pool.
export const dynamic = "force-static";
export const revalidate = 3600;

// Tier pills: emoji + color are language-neutral; the label comes from i18n.
const TIER_PILLS: { key: TierKey; emoji: string; cls: string }[] = [
  { key: "god", emoji: "🏆", cls: "text-amber-300" },
  { key: "elite", emoji: "🥇", cls: "text-violet-300" },
  { key: "solid", emoji: "💪", cls: "text-emerald-300" },
  { key: "npc", emoji: "🫥", cls: "text-slate-300" },
  { key: "trash", emoji: "💩", cls: "text-rose-400" },
];

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const tt = await getTranslations("tiers");
  const tNav = await getTranslations("nav");
  const faqItems = await getFaqItems();

  return (
    <main className="flex flex-1 flex-col items-center px-5 pb-14 pt-2 sm:px-6 sm:pb-20 sm:pt-3">
      <JsonLd data={faqJsonLd(faqItems)} />
      {/* Compact hero: every element survives, sized so the hero + idle scan
          form stay ≈320px and the content zone peeks into the first screen. */}
      <header className="mb-6 flex w-full max-w-4xl flex-col items-center text-center">
        <p className="mb-3 text-sm font-bold tracking-wide text-zinc-400">
          {t("brand")} <span className="text-orange-500">GitHub</span>
        </p>
        <h1 className="max-w-2xl whitespace-pre-line text-balance text-2xl font-black tracking-tight sm:text-4xl">
          {t("headline")}
        </h1>
        <p className="mt-2 max-w-md text-sm font-semibold tracking-wide text-zinc-300 sm:text-base">
          {t("subtitle")}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
          <DeveloperCount />
          {TIER_PILLS.map(({ key, emoji, cls }) => (
            <span
              key={key}
              className={`rounded-full border border-white/10 px-2 py-0.5 text-[11px] ${cls}`}
            >
              {emoji} {tt(`${key}.name`)}
            </span>
          ))}
        </div>
      </header>

      <Roaster />

      {/* Content zone: directory-style two-column layout on desktop — main
          stream (editor's picks + project feed slot) with a sticky right rail
          (leaderboard teaser + discover links). Mobile folds to a single
          column, main content first. Pattern mirrors /u/[username]. */}
      <div className="mt-12 flex w-full max-w-6xl flex-col gap-10 lg:flex-row lg:items-start lg:gap-8">
        <div className="flex min-w-0 flex-1 flex-col gap-12">
          <HomeCollections locale={locale} />
          <HomeProjectsPreview />
        </div>
        <aside className="flex w-full flex-col gap-6 lg:sticky lg:top-20 lg:w-80 lg:shrink-0">
          <Suspense
            fallback={
              <div className="h-96 animate-pulse rounded-2xl border border-white/5 bg-white/5" />
            }
          >
            <LeaderboardRail />
          </Suspense>
          <nav
            aria-label={tNav("discover")}
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
          >
            <h2 className="px-2 text-sm font-black tracking-wide text-zinc-100">
              {tNav("discover")}
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                { href: "/developers", label: tNav("developers"), emoji: "🧑‍💻" },
                { href: "/projects", label: tNav("projects"), emoji: "📦" },
                { href: "/collections", label: tNav("collections"), emoji: "⭐" },
                { href: "/vs", label: tNav("versus"), emoji: "⚔️" },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm font-semibold text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-zinc-100"
                >
                  <span className="me-1.5">{item.emoji}</span>
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        </aside>
      </div>

      <HomeIntro />

      <HomeFaq items={faqItems} />

      <footer className="mt-20 max-w-xl text-center text-xs leading-relaxed text-zinc-600">
        <p>{t.rich("disclaimer1", { b: (c) => <strong>{c}</strong> })}</p>
        <p className="mt-2">
          {t.rich("disclaimer2", {
            code: (c) => <code className="text-zinc-400">{c}</code>,
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
