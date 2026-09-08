import { feedJson, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";
import { forwardFeedRequest } from "@/lib/feed-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  return await forwardFeedRequest(request, viewer) ?? feedJson({ error: "deletion_not_found" }, { status: 404 });
}
