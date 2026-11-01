import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { localeAlternates, localePath } from "@/lib/site";
import { getGoVsPresentation } from "@/lib/go-profile.server";
import { VsView } from "@/components/pages/VsView";
import { canonicalize, isCanonicalVsPath, vsMeta } from "@/lib/pages/vs";
import { asTranslator } from "@/lib/translator";

export const dynamic = "force-dynamic";

// Dedupe the Go presentation read between metadata and page rendering.
const getVs = cache((a: string, b: string) => getGoVsPresentation(a, b));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; a: string; b: string }>;
}): Promise<Metadata> {
  const { locale, a, b } = await params;
  const t = await getTranslations({ locale, namespace: "vs" });
  const pair = canonicalize(a, b);
  if (!pair) return { title: t("heading") };
  const title = t("metaTitle", { a: pair.a, b: pair.b });
  const description = t("metaDescription", { a: pair.a, b: pair.b });
  const { image, indexable, path } = vsMeta(locale, pair, await getVs(pair.a, pair.b));
  return {
    title,
    description,
    robots: indexable ? undefined : { index: false, follow: true },
    alternates: localeAlternates(locale, path),
    openGraph: {
      title,
      description,
      url: localePath(locale, path),
      type: "website",
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function VsPage({
  params,
}: {
  params: Promise<{ locale: string; a: string; b: string }>;
}) {
  const { locale, a, b } = await params;
  const pair = canonicalize(a, b);
  if (!pair) notFound();

  // Redirect any non-canonical spelling (case / order) to the canonical slug so
  // /vs/b/a and /vs/A/B consolidate to one URL (and one OG image / cache entry).
  if (!isCanonicalVsPath(a, b, pair)) {
    redirect({ href: `/vs/${pair.a}/${pair.b}`, locale });
  }

  setRequestLocale(locale);
  const [t, tDim, tTier, tRealm, presentation] = await Promise.all([
    getTranslations("vs"),
    getTranslations("dimensions"),
    getTranslations("tiers"),
    getTranslations("realms"),
    getVs(pair.a, pair.b),
  ]);
  return (
    <VsView
      locale={locale}
      pair={pair}
      presentation={presentation}
      t={asTranslator(t)}
      tDim={asTranslator(tDim)}
      tTier={asTranslator(tTier)}
      tRealm={asTranslator(tRealm)}
    />
  );
}
