import { useTranslations } from "next-intl";
import { HomeCollections } from "@/components/HomeCollections";
import type { HomeCollectionCard } from "@/lib/pages/home";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

function HomeCollectionsBody({ locale, cards }: { locale: string; cards: HomeCollectionCard[] }) {
  return <HomeCollections locale={locale} cards={cards} t={useTranslations("collections")} tBlog={useTranslations("blog")} />;
}

export function HomeCollectionsIsland({ intl, locale, cards }: WithIntl<{ locale: string; cards: HomeCollectionCard[] }>) {
  return <IslandRoot intl={intl}><HomeCollectionsBody locale={locale} cards={cards} /></IslandRoot>;
}
