import { CommentBubbles } from "@/components/CommentBubbles";

export function CollectionCommentBubbles({
  lang,
  collectionSlug,
}: {
  lang: "zh" | "en";
  collectionSlug: string;
}) {
  return (
    <CommentBubbles
      commentsEndpoint={`/api/collection-comments/${encodeURIComponent(collectionSlug)}`}
      contentHalfWidth="24rem"
      lang={lang}
      loadOnMount
    />
  );
}
