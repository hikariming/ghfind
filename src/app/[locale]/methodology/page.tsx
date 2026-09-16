import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { localeAlternates } from "@/lib/site";

export const dynamic = "force-static";

const DIMENSION_KEYS = [
  "account_maturity",
  "original_project_quality",
  "contribution_quality",
  "ecosystem_impact",
  "community_influence",
  "activity_authenticity",
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "methodology" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/methodology"),
  };
}

export default async function MethodologyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("methodology");
  const tDim = await getTranslations("dimensions");
  const details = t.raw("dimensionDetails") as Record<string, string>;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-14 sm:py-20">
      <h1 className="text-3xl font-black tracking-tight text-[var(--foreground)] sm:text-5xl">
        {t("heading")}
      </h1>
      <p className="mt-6 text-lg leading-relaxed text-zinc-300">{t("lead")}</p>

      <section className="mt-12">
        <h2 className="text-2xl font-bold text-[var(--foreground)]">
          {t("dimensionsHeading")}
        </h2>
        <p className="mt-3 text-base leading-relaxed text-zinc-400">
          {t("dimensionsIntro")}
        </p>
        <dl className="mt-6 flex flex-col gap-5">
          {DIMENSION_KEYS.map((key) => (
            <div
              key={key}
              className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
            >
              <dt className="font-bold text-[var(--foreground)]">{tDim(key)}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                {details[key]}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {(["penalties", "determinism", "baseVsFinal", "data"] as const).map((k) => (
        <section key={k} className="mt-12">
          <h2 className="text-2xl font-bold text-[var(--foreground)]">
            {t(`${k}Heading`)}
          </h2>
          <p className="mt-3 text-base leading-relaxed text-zinc-300">
            {t(`${k}Body`)}
          </p>
        </section>
      ))}
    </main>
  );
}
