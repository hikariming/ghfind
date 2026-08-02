import { CommentBubbles } from "@/components/CommentBubbles";
import type { ProfileComment } from "@/lib/comments";

export function FloatingCommentBubbles({
  initialComments,
  lang,
  profileUsername,
}: {
  initialComments: ProfileComment[];
  lang: "zh" | "en";
  profileUsername: string;
}) {
  return (
    <CommentBubbles
      commentsEndpoint={`/api/profile-comments/${encodeURIComponent(profileUsername)}`}
      contentHalfWidth="28rem"
      initialComments={initialComments}
      lang={lang}
    />
  );
}
