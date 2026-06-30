import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DeveloperCount } from "@/components/DeveloperCount";
import { HomeLeaderboard } from "@/components/HomeLeaderboard";
import { Roaster } from "@/components/Roaster";
import type { TierKey } from "@/lib/tier";

// ISR: the homepage shell is fully static (the scan form, tier pills and copy are
// locale-only; DeveloperCount fetches client-side; the leaderboard preview reads
// the cached board). Serving it from the CDN instead of rendering a function on
// every visit is what frees the serverless pool for the LLM scan/roast traffic.
// 60s keeps the leaderboard preview fresh enough; the window selector refetches
// live client-side anyway.
// Pin the homepage to static + ISR. Next 16's "auto" heuristic otherwise renders
// it on demand (a function per visit); forcing static serves the shell from the
// CDN and revalidates the leaderboard preview every 60s. This is the change that
// takes the bulk of homepage traffic off the serverless pool.
export const dynamic = "force-static";
export const revalidate = 60;

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

  return (
    <main className="flex flex-1 flex-col items-center px-5 py-14 sm:py-20">
      <header className="mb-10 flex flex-col items-center text-center">
        <p className="mb-3 text-sm font-bold tracking-wide text-zinc-400">
          {t("brand")} <span className="text-orange-500">GitHub</span>
        </p>
        <h1 className="max-w-2xl text-balance text-4xl font-black tracking-tight sm:text-5xl">
          {t("headline")}
        </h1>
        <p className="mt-3 max-w-md text-base font-semibold tracking-wide text-zinc-300 sm:text-lg">
          {t("subtitle")}
        </p>
        <DeveloperCount />
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs">
          {TIER_PILLS.map(({ key, emoji, cls }) => (
            <span
              key={key}
              className={`rounded-full border border-white/10 px-2.5 py-1 ${cls}`}
            >
              {emoji} {tt(`${key}.name`)}
            </span>
          ))}
        </div>
      </header>

      <Roaster />

      <Suspense
        fallback={
          <section className="mt-16 w-full max-w-4xl">
            <div className="h-72 animate-pulse rounded-2xl border border-white/5 bg-white/5" />
          </section>
        }
      >
        <HomeLeaderboard pageSize={10} />
      </Suspense>

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
