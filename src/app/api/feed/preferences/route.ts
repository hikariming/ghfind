import { feedErrorResponse, feedJson, feedJsonBody, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";
import { getFeedPreferences, replaceFeedPreferences } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  try {
    return feedJson(await getFeedPreferences(viewer));
  } catch (error) {
    return feedErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
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
