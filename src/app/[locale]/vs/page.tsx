import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getTrendingMatchups } from "@/lib/db";
import { localeAlternates } from "@/lib/site";
import { VsBattleBox } from "@/components/VsBattleBox";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "vs" });
  return {
    title: t("trendingHeading"),
    description: t("trendingSub"),
    alternates: localeAlternates(locale, "/vs"),
  };
}

export default async function VsIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("vs");
  const matchups = await getTrendingMatchups(40);

  return (
    <main className="relative isolate flex w-full flex-1 justify-center px-5 py-14 sm:py-20">
      <div className="flex w-full max-w-3xl flex-col">
        <h1 className="text-center text-2xl font-black text-zinc-100">{t("trendingHeading")}</h1>
        <p className="mt-2 text-center text-sm text-zinc-400">{t("trendingSub")}</p>

        <div className="mt-8">
          <VsBattleBox />
        </div>

        {matchups.length === 0 ? (
          <p className="mt-10 text-center text-sm text-zinc-500">{t("trendingEmpty")}</p>
        ) : (
          <div className="mt-8 flex flex-col gap-2">
            {matchups.map((m) => {
              const line = locale === "en" ? m.verdict?.en || m.verdict?.zh : m.verdict?.zh || m.verdict?.en;
              const aWon = m.winner === m.handleA;
              const bWon = m.winner === m.handleB;
              return (
                <Link
                  key={`${m.handleA}-${m.handleB}`}
                  href={`/vs/${m.handleA}/${m.handleB}`}
                  prefetch={false}
                  className="flex flex-col gap-1 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 hover:bg-white/[0.06]"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <span className={`truncate font-semibold ${aWon ? "text-emerald-300" : "text-zinc-300"}`}>
                        @{m.handleA}
                      </span>
                      <span className="shrink-0 tabular-nums text-zinc-500">{m.scoreA.toFixed(1)}</span>
                      <span className="shrink-0 text-orange-500">VS</span>
                      <span className="shrink-0 tabular-nums text-zinc-500">{m.scoreB.toFixed(1)}</span>
                      <span className={`truncate font-semibold ${bWon ? "text-emerald-300" : "text-zinc-300"}`}>
                        @{m.handleB}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-500">👁 {m.viewCount}</span>
                  </div>
                  {line && <p className="line-clamp-1 text-xs text-zinc-400">🔥 {line}</p>}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
