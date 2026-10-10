import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { listCollections } from "@/lib/collections";
import { localeAlternates } from "@/lib/site";
import { CollectionsIndexView } from "@/components/pages/CollectionViews";
import { asTranslator } from "@/lib/translator";

// Reads the collection list from D1 per request (the build has no D1 binding).
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "collections" });
  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    alternates: localeAlternates(locale, "/collections"),
  };
}

export default async function CollectionsIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("collections");
  const tBlog = await getTranslations("blog");
  return (
    <CollectionsIndexView
      locale={locale}
      collections={await listCollections()}
      t={asTranslator(t)}
      tBlog={asTranslator(tBlog)}
    />
  );
}
