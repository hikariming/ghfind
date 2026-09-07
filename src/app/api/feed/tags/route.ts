import { feedErrorResponse, feedJson, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";
import { listFeedTags } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  try {
    return feedJson(await listFeedTags());
  } catch (error) {
    return feedErrorResponse(error);
  }
}
