import type { Metadata } from "next";
import { connection } from "next/server";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { Leaderboard } from "@/components/Leaderboard";
import { JsonLd, leaderboardJsonLd } from "@/components/JsonLd";
import { getLeaderboard } from "@/lib/db";
import type { LeaderboardView } from "@/components/LeaderboardClient";

export const dynamic = "force-dynamic";

const REMOVAL_ISSUE_URL =
  "https://github.com/hikariming/github-roast/issues/new?title=%E7%94%B3%E8%AF%B7%E4%B8%8B%E6%A6%9C&body=%E8%AF%B7%E5%A1%AB%E5%86%99%E4%BD%A0%E7%9A%84%20GitHub%20%E7%94%A8%E6%88%B7%E5%90%8D%EF%BC%9A";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leaderboard" });
  return {
    title: `${t("heading")} · ${(await getTranslations({ locale, namespace: "meta" }))("siteName")}`,
    description: t("subtitle"),
  };
}

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ view?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const view: LeaderboardView =
    query?.view === "score"
      ? "score"
      : query?.view === "heat"
        ? "heat"
        : "trending";
  await connection();
  setRequestLocale(locale);
  const t = await getTranslations("leaderboard");
  const viewTitle =
    view === "score"
      ? t("scoreView")
      : view === "heat"
        ? t("heatView")
        : t("trendView");
  const subtitle =
    view === "score"
      ? t("scoreSubtitle")
      : view === "heat"
        ? t("heatSubtitle")
        : t("trendSubtitle");
  const tabClass = (tab: LeaderboardView) =>
    `shrink-0 snap-start whitespace-nowrap rounded-full px-3 py-1.5 text-center transition-colors ${
      view === tab ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
    }`;

  // Structured data only for the canonical score ranking — the directory's main
  // "top developers" list. Heat is a sort variant behind query params, so
  // emitting one ItemList keeps the markup unambiguous for crawlers.
  const rankingEntries = view === "score" ? await getLeaderboard(50) : [];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-14 sm:py-20">
      {rankingEntries.length > 0 && (
        <JsonLd
          data={leaderboardJsonLd({
            name: t("heading"),
            description: t("subtitle"),
            locale,
            entries: rankingEntries,
          })}
        />
      )}
      <header className="mb-8">
        <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-black leading-tight tracking-tight text-zinc-100 sm:text-5xl">
              {t("heading")}
            </h1>
            <p className="mt-2 text-lg font-black text-zinc-300 sm:text-xl">{viewTitle}</p>
            <div className="mt-4 flex w-full max-w-full snap-x items-center gap-1 overflow-x-auto rounded-full border border-white/10 bg-white/[0.03] p-1 text-sm font-bold sm:max-w-[40rem]">
              <Link href="/leaderboard" className={tabClass("trending")}>
                {t("trendView")}
              </Link>
              <Link href="/leaderboard?view=score" className={tabClass("score")}>
                {t("scoreView")}
              </Link>
              <Link href="/leaderboard?view=heat" className={tabClass("heat")}>
                {t("heatView")}
              </Link>
            </div>
          </div>
          <Link
            href="/"
            className="w-full shrink-0 rounded-full bg-orange-600 px-4 py-2 text-center text-xs font-medium text-white hover:bg-orange-500 sm:w-auto sm:px-5 sm:text-sm"
          >
            {t("judgeCta")}
          </Link>
        </div>
        <p className="mt-2 text-zinc-400">{subtitle}</p>
      </header>

      <Leaderboard pageSize={20} initialView={view} />

      <footer className="mt-12 text-center text-xs leading-relaxed text-zinc-600">
        {t.rich("footerNote", {
          a: (c) => (
            <a
              href={REMOVAL_ISSUE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
            >
              {c}
            </a>
          ),
        })}
      </footer>
    </main>
  );
}
