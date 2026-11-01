import type { Translator } from "@/lib/translator";

const DIMENSION_KEYS = [
  "account_maturity",
  "original_project_quality",
  "contribution_quality",
  "ecosystem_impact",
  "community_influence",
  "activity_authenticity",
] as const;

/** Body of the /methodology page, shared by the Next app and apps/web (see BlogViews). */
export function MethodologyView({ t, tDim }: { t: Translator; tDim: Translator }) {
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

      {(["penalties", "determinism", "data"] as const).map((k) => (
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
