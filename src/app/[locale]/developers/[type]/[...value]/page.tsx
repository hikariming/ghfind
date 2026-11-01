import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DeveloperFacetView } from "@/components/pages/DeveloperFacetView";
import {
  bucketHeadingKey,
  facetEncodedPath,
  facetValueFromSegments,
  loadDeveloperFacet,
  parseFacetType,
} from "@/lib/pages/developer-facet";
import { localeAlternates } from "@/lib/site";
import { asTranslator } from "@/lib/translator";

// Keep this long-tail route out of ISR. The URL space is ~10k buckets × 9
// locales, and verified crawlers overwhelmingly request each URL only once.
// Those requests already execute the page on an ISR MISS, then additionally
// pay to persist several HTML/RSC artifacts that are rarely read again. The
// underlying facet data remains Redis-cached, so dynamic rendering removes the
// durable ISR writes without turning every request into a database query.
//
// `?u=` is still resolved client-side by FacetBoardPinFromQuery, so this can be
// revisited if repeat human traffic ever outweighs crawler cold misses.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; type: string; value: string[] }>;
}): Promise<Metadata> {
  const { locale, type: rawType, value: rawValue } = await params;
  const type = parseFacetType(rawType);
  const value = facetValueFromSegments(rawValue);
  const t = await getTranslations({ locale, namespace: "developers" });
  const meta = await getTranslations({ locale, namespace: "meta" });
  if (!type) return { title: t("metaTitle") };
  const heading = t(bucketHeadingKey(type), { value });
  // Encode each segment separately so a `repo` value ("owner/name") keeps its
  // slash as a path separator — mirrors the sitemap so canonical == indexed URL.
  const encodedPath = facetEncodedPath(value);
  return {
    title: `${heading} · ${meta("siteName")}`,
    description: t("bucketMetaDescription", { value }),
    alternates: localeAlternates(locale, `/developers/${type}/${encodedPath}`),
  };
}

export default async function FacetBucketPage({
  params,
}: {
  params: Promise<{ locale: string; type: string; value: string[] }>;
}) {
  const { locale, type: rawType, value: rawValue } = await params;
  const type = parseFacetType(rawType);
  const value = facetValueFromSegments(rawValue);
  if (!type || !value) notFound();

  setRequestLocale(locale);
  const [t, tl, tTier, tProjects, data] = await Promise.all([
    getTranslations("developers"),
    getTranslations("leaderboard"),
    getTranslations("tiers"),
    getTranslations("projectBoards"),
    loadDeveloperFacet(type, value),
  ]);
  if (!data) notFound();
  return (
    <DeveloperFacetView
      locale={locale}
      type={type}
      value={value}
      t={asTranslator(t)}
      tl={asTranslator(tl)}
      tTier={asTranslator(tTier)}
      tProjects={asTranslator(tProjects)}
      {...data}
    />
  );
}
