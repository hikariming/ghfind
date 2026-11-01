import { CollectionCommentBubbles } from "@/components/CollectionCommentBubbles";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function CollectionCommentsIsland({ intl, lang, collectionSlug }: WithIntl<{ lang: "zh" | "en"; collectionSlug: string }>) {
  return <IslandRoot intl={intl}><CollectionCommentBubbles lang={lang} collectionSlug={collectionSlug} /></IslandRoot>;
}
