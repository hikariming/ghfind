import { forwardFeedRequest } from "@/lib/feed-gateway";
import { feedErrorResponse, feedJson, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";
import { listFeedTags } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  const forwarded = await forwardFeedRequest(request, viewer);
  if (forwarded) return forwarded;
  try {
    return feedJson(await listFeedTags());
  } catch (error) {
    return feedErrorResponse(error);
  }
}
