import { getTranslations } from "next-intl/server";
import { NAMED_STATS } from "@/lib/agent-docs";

type Step = { title: string; body: string };
type TableRow = { signal: string; measures: string; gameable: string };

/**
 * Server-rendered "what is / how it works / by the numbers" prose. Like HomeFaq,
 * this is pure static text (no client JS): it exists so the crawlable homepage
 * HTML carries a definitional paragraph, an H2/H3 hierarchy, named statistics,
 * and a comparison table that LLMs and RAG indexers can lift verbatim.
 */
export async function HomeIntro() {
  const t = await getTranslations("homeIntro");
  const steps = t.raw("steps") as Step[];
  const rows = t.raw("tableRows") as TableRow[];

  return (
    <section className="home-intro mt-20 w-full max-w-3xl">
      <h2 className="text-center text-2xl font-black tracking-tight text-[var(--foreground)] sm:text-3xl">
        {t("whatHeading")}
      </h2>
      <p className="mt-5 text-sm leading-relaxed text-zinc-400">{t("whatBody")}</p>

      <h2 className="mt-12 text-center text-2xl font-black tracking-tight text-[var(--foreground)] sm:text-3xl">
        {t("howHeading")}
      </h2>
      <ol className="mt-5 flex flex-col gap-4">
        {steps.map((step, i) => (
          <li
            key={i}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
          >
            <h3 className="font-bold text-[var(--foreground)]">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{step.body}</p>
          </li>
        ))}
      </ol>

      <h2 className="mt-12 text-center text-2xl font-black tracking-tight text-[var(--foreground)] sm:text-3xl">
        {t("numbersHeading")}
      </h2>
      <ul className="mt-5 list-disc space-y-2 ps-5 text-sm leading-relaxed text-zinc-400">
        <li>{t("numbers.accounts", { count: NAMED_STATS.accountsScored })}</li>
        <li>{t("numbers.snapshots", { count: NAMED_STATS.fullSnapshots })}</li>
        <li>{t("numbers.dimensions", { count: NAMED_STATS.dimensions })}</li>
        <li>{t("numbers.flagged", { share: NAMED_STATS.flaggedShare })}</li>
      </ul>

      <div className="mt-8 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="mb-3 text-start font-bold text-[var(--foreground)]">
            {t("tableCaption")}
          </caption>
          <thead>
            <tr className="border-b border-[var(--border)] text-start text-zinc-400">
              <th className="py-2 pe-4 font-semibold">{t("tableColSignal")}</th>
              <th className="py-2 pe-4 font-semibold">{t("tableColMeasures")}</th>
              <th className="py-2 font-semibold">{t("tableColGameable")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-[var(--border)]/50 align-top">
                <th scope="row" className="py-2 pe-4 text-start font-semibold text-[var(--foreground)]">
                  {row.signal}
                </th>
                <td className="py-2 pe-4 text-zinc-400">{row.measures}</td>
                <td className="py-2 text-zinc-400">{row.gameable}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
