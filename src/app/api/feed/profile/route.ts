import { deleteFeedProfile } from "@/lib/feed";
import { feedErrorResponse, feedJson, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE() {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  try {
    return feedJson(await deleteFeedProfile(viewer));
  } catch (error) {
    return feedErrorResponse(error);
  }
}
