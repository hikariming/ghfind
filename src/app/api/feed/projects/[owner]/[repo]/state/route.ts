import { feedErrorResponse, feedJson, feedJsonBody, isFeedResponse, requireFeedViewer } from "@/lib/feed-api";
import { FeedError, updateFeedProjectState } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
) {
  const viewer = await requireFeedViewer();
  if (isFeedResponse(viewer)) return viewer;
  try {
    const { owner, repo } = await params;
    const body = await feedJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new FeedError("invalid_state_patch", 400, "Expected a project state object.");
    }
    return feedJson(await updateFeedProjectState(viewer, `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`, body as Record<string, unknown>));
  } catch (error) {
    return feedErrorResponse(error);
  }
}
