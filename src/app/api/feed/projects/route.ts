import { feedErrorResponse, feedJson, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";
import { FeedError, getFeedPage } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  try {
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit") ?? "20";
    if (!/^\d+$/.test(rawLimit)) throw new FeedError("invalid_pagination", 400, "limit must be an integer from 1 to 50.");
    return feedJson(await getFeedPage(viewer, {
      limit: Number(rawLimit),
      cursor: url.searchParams.get("cursor"),
    }));
  } catch (error) {
    return feedErrorResponse(error);
  }
}
