import type { Translator } from "@/lib/translator";

/** Body of the /privacy page, shared by the Next app and apps/web (see BlogViews). */
export function PrivacyView({ t }: { t: Translator }) {
  const sections = t.raw("sections") as { h: string; p: string }[];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-14 sm:py-20">
      <h1 className="text-3xl font-black tracking-tight text-[var(--foreground)] sm:text-5xl">
        {t("heading")}
      </h1>
      <div className="mt-8 flex flex-col gap-8">
        {sections.map((s, i) => (
          <section key={i}>
            <h2 className="text-xl font-bold text-[var(--foreground)]">{s.h}</h2>
            <p className="mt-3 text-base leading-relaxed text-zinc-300">{s.p}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
