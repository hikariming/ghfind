import { BlogCommentBubbles } from "@/components/BlogCommentBubbles";
import { IslandRoot } from "./IslandRoot";
import type { WithIntl } from "./types";

export function BlogCommentsIsland({ intl, lang, postSlug }: WithIntl<{ lang: "zh" | "en"; postSlug: string }>) {
  return <IslandRoot intl={intl}><BlogCommentBubbles lang={lang} postSlug={postSlug} /></IslandRoot>;
}
