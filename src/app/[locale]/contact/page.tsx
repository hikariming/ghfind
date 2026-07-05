import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { localeAlternates, SITE_URL } from "@/lib/site";

export const dynamic = "force-static";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "contact" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/contact"),
  };
}

export default async function ContactPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("contact");
  const paragraphs = t.raw("paragraphs") as string[];

  const resources: { label: string; href: string }[] = [
    { label: t("apiLabel"), href: `${SITE_URL}/openapi.json` },
    { label: t("llmsLabel"), href: `${SITE_URL}/llms.txt` },
    { label: t("authLabel"), href: `${SITE_URL}/auth.md` },
  ];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-14 sm:py-20">
      <h1 className="text-3xl font-black tracking-tight text-[var(--foreground)] sm:text-5xl">
        {t("heading")}
      </h1>
      <div className="mt-8 flex flex-col gap-5 text-base leading-relaxed text-zinc-300">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      <a
        href={t("issuesUrl")}
        className="mt-8 inline-flex w-fit items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-3 font-semibold text-[var(--foreground)] transition-colors hover:border-[var(--primary)] hover:text-[var(--primary)]"
        rel="noopener"
      >
        {t("issuesLabel")} →
      </a>

      <p className="mt-8 text-base leading-relaxed text-zinc-300">
        {t("bizLead")}{" "}
        <a
          href="mailto:lbm21@tsinghua.org.cn"
          className="font-semibold text-[var(--primary)] hover:underline"
        >
          lbm21@tsinghua.org.cn
        </a>
        <span className="block mt-1 text-sm text-zinc-500">{t("bizNote")}</span>
      </p>

      <h2 className="mt-12 text-lg font-bold text-[var(--foreground)]">
        {t("resourcesLabel")}
      </h2>
      <ul className="mt-3 flex flex-col gap-2 text-[var(--primary)]">
        {resources.map((r) => (
          <li key={r.href}>
            <a href={r.href} className="hover:underline" rel="noopener">
              {r.label}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
