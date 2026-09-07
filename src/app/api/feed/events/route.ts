import { appendFeedEvents } from "@/lib/feed";
import { feedErrorResponse, feedJson, feedJsonBody, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  try {
    const body = await feedJsonBody(request);
    const events = Array.isArray(body) ? body : (body as Record<string, unknown> | null)?.events;
    return feedJson(await appendFeedEvents(viewer, events), { status: 202 });
  } catch (error) {
    return feedErrorResponse(error);
  }
}
