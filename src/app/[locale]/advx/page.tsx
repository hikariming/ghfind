import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { CampaignLeaderboard } from "@/components/CampaignLeaderboard";
import { Roaster } from "@/components/Roaster";
import { Link } from "@/i18n/navigation";
import { localeAlternates } from "@/lib/site";

// Keep the event page server-rendered for the first paint and crawler HTML, but
// use the same bounded ISR window as the homepage. The route only has the nine
// allow-listed locales from the parent layout, so this cannot create an
// unbounded ISR key space from user input.
export const dynamic = "force-static";
export const revalidate = 60;

const COPY = {
  zh: {
    title: "AdventureX 现场开发者榜",
    description: "输入 GitHub 用户名加入 AdventureX 现场榜，成绩同时进入 ghfind 主榜单。",
    subtitle: {
      lead: "测测你是 AdventureX 现场最",
      accent: "夯",
      trail: "的开源社区开发者吗？",
    },
    inputPlaceholder: "输入 GitHub 账号，开始评分",
    officialSite: "AdventureX 2026 官网",
    privacy: "欢迎来 ghfind 摊子前领取免费物料，现场定制你的炫耀卡。",
    board: "龙虎榜",
    live: "现场榜单在 ghfind 摊位大屏实时播报",
    refresh: "刷新榜单",
    empty: "还没有参赛者，输入第一个 GitHub 用户名开榜吧。",
  },
  en: {
    title: "AdventureX Live Developer Leaderboard",
    description: "Score a GitHub account and join the AdventureX live leaderboard on ghfind.",
    subtitle: {
      lead: "Enter a GitHub username, get scored, and see who leads the room.",
      accent: "",
      trail: "",
    },
    inputPlaceholder: "Enter a GitHub account to start scoring",
    officialSite: "AdventureX 2026 website",
    privacy: "This page only shows accounts registered on site at ADVX.",
    board: "AdventureX live ranking",
    live: "Live leaderboard updates",
    refresh: "Refresh board",
    empty: "No participants yet. Enter the first GitHub username to open the board.",
  },
} as const;

function pageCopy(locale: string) {
  return locale === "zh" ? COPY.zh : COPY.en;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const copy = pageCopy(locale);
  return {
    title: `${copy.title} · ghfind`,
    description: copy.description,
    alternates: localeAlternates(locale, "/advx"),
  };
}

export default async function AdventureXPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const copy = pageCopy(locale);

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden px-5 py-12 sm:px-6 sm:py-16">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[40rem] bg-[radial-gradient(circle_at_14%_8%,rgba(255,116,0,0.2),transparent_36%),radial-gradient(circle_at_82%_12%,rgba(255,191,128,0.12),transparent_30%)]" />
      <header className="advx-event-hero relative mx-auto mb-9 w-full max-w-6xl overflow-hidden rounded-3xl border border-orange-400/20 p-6 shadow-2xl shadow-orange-950/10 sm:p-9 lg:p-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-3 -top-10 select-none font-mono text-[8.5rem] font-black leading-none tracking-[-0.12em] text-orange-500/[0.07] sm:text-[13rem] lg:text-[17rem]"
        >
          2026
        </div>
        <div className="relative min-w-0">
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <span className="text-xl font-black tracking-tight text-zinc-100 sm:text-2xl">
              ghfind
            </span>
            <span aria-hidden="true" className="text-orange-400">
              ×
            </span>
            <a
              href="https://adventure-x.org/zh"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={copy.officialSite}
              className="transition-opacity hover:opacity-75"
            >
              {/* Official AdventureX wordmark from the event website. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://adventure-x.org/adventure-x.svg"
                alt="AdventureX"
                className="advx-wordmark h-5 w-auto sm:h-6"
              />
            </a>
          </div>
          <h1 className="mt-8 max-w-none whitespace-nowrap text-[clamp(0.625rem,3vw,2.625rem)] font-black leading-none tracking-[-0.04em] text-zinc-100">
            {copy.subtitle.lead}
            {copy.subtitle.accent ? (
              <span className="advx-accent-text inline-block align-[-0.08em] text-[1.65em] leading-none">
                {copy.subtitle.accent}
              </span>
            ) : null}
            {copy.subtitle.trail}
          </h1>
        </div>
      </header>

      <section className="mx-auto w-full max-w-6xl rounded-3xl border border-white/10 bg-white/[0.02] p-4 shadow-2xl shadow-orange-950/10 sm:p-8">
        <Roaster
          campaign="advx"
          analyticsSource="advx"
          inputPlaceholder={copy.inputPlaceholder}
        />
        <p className="mx-auto mt-5 max-w-2xl text-center text-xs leading-relaxed text-zinc-500 sm:text-sm">
          {copy.privacy}
        </p>
      </section>

      <section className="mx-auto mt-14 w-full max-w-5xl sm:mt-20">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="mt-1 text-2xl font-black text-zinc-100 sm:text-3xl">
              {copy.board}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">{copy.live}</p>
          </div>
          <Link
            href="/advx"
            className="rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs font-semibold text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            ↻ {copy.refresh}
          </Link>
        </div>
        <CampaignLeaderboard campaign="advx" locale={locale} emptyLabel={copy.empty} />
      </section>
    </main>
  );
}
