import { getTranslations } from "next-intl/server";

export type FaqItem = {
  q: string;
  a: string;
  repo?: string;
  repoUrl?: string;
  afterRepo?: string;
};

/** Load the FAQ items once so the same array feeds the rendered section and the
 *  FAQPage JSON-LD (no drift between what users read and what agents parse). */
export async function getFaqItems(): Promise<FaqItem[]> {
  const t = await getTranslations("faq");
  return t.raw("items") as FaqItem[];
}

/**
 * Server-rendered FAQ. Pure static text (no client JS), so it raises the
 * homepage's crawlable content density and gives LLMs clean, extractable Q&A
 * passages. The `home-faq` class is the speakable selector in the JSON-LD.
 */
export async function HomeFaq({ items }: { items: FaqItem[] }) {
  const t = await getTranslations("faq");
  return (
    <section className="home-faq mt-20 w-full max-w-5xl">
      <h2 className="text-center text-2xl font-black tracking-tight text-[var(--foreground)] sm:text-3xl">
        {t("heading")}
      </h2>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {items.map((item, i) => (
          <details
            key={i}
            className="group rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
            {...(i === 0 ? { open: true } : {})}
          >
            <summary className="cursor-pointer list-none font-bold text-[var(--foreground)] marker:hidden">
              {item.q}
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              {item.repo && item.repoUrl ? (
                <>
                  {item.a}{" "}
                  <a
                    href={item.repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-orange-400 underline underline-offset-2 hover:text-orange-300"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      className="size-4 fill-current"
                    >
                      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.26c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.2.08 1.84 1.23 1.84 1.23 1.07 1.83 2.8 1.3 3.49 1 .11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.23-3.22-.12-.3-.53-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.62-2.8 5.64-5.48 5.94.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z" />
                    </svg>
                    {item.repo}
                  </a>{" "}
                  {item.afterRepo}
                </>
              ) : (
                item.a
              )}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
