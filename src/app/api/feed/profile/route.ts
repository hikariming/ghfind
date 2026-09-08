import { forwardFeedRequest } from "@/lib/feed-gateway";
import { deleteFeedProfile } from "@/lib/feed";
import { feedErrorResponse, feedJson, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  const forwarded = await forwardFeedRequest(request, viewer);
  if (forwarded) return forwarded;
  try {
    return feedJson(await deleteFeedProfile(viewer));
  } catch (error) {
    return feedErrorResponse(error);
  }
}
