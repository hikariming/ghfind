import { CommentBubbles } from "@/components/CommentBubbles";

export function BlogCommentBubbles({
  lang,
  postSlug,
}: {
  lang: "zh" | "en";
  postSlug: string;
}) {
  return (
    <CommentBubbles
      commentsEndpoint={`/api/blog-comments/${encodeURIComponent(postSlug)}`}
      contentHalfWidth="24rem"
      lang={lang}
      loadOnMount
    />
  );
}
