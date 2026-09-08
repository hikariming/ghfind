import { forwardFeedRequest } from "@/lib/feed-gateway";
import { feedErrorResponse, feedJson, feedJsonBody, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";
import { getFeedPreferences, replaceFeedPreferences } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  const forwarded = await forwardFeedRequest(request, viewer);
  if (forwarded) return forwarded;
  try {
    return feedJson(await getFeedPreferences(viewer));
  } catch (error) {
    return feedErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  const forwarded = await forwardFeedRequest(request, viewer);
  if (forwarded) return forwarded;
  try {
    const body = await feedJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return feedJson({ error: "invalid_body", message: "Expected a preference object." }, { status: 400 });
    }
    const value = body as Record<string, unknown>;
    return feedJson(await replaceFeedPreferences(viewer, {
      taxonomyVersion: Number(value.taxonomyVersion),
      preferences: Array.isArray(value.preferences) ? value.preferences.map((entry) => {
        const item = entry as Record<string, unknown>;
        return { tagId: typeof item?.tagId === "string" ? item.tagId : "", value: Number(item?.value) };
      }) : [],
    }));
  } catch (error) {
    return feedErrorResponse(error);
  }
}
