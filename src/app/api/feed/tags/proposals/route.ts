import { feedJson, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";
import { forwardFeedRequest } from "@/lib/feed-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  return await forwardFeedRequest(request, viewer) ?? feedJson({ error: "feed_unavailable" }, { status: 503 });
}
