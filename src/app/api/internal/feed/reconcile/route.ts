import { feedJson, internalFeedAuthorized } from "@/lib/feed-api";
import { reconcileFeedCatalog } from "@/lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function reconcile(request: Request) {
  if (!internalFeedAuthorized(request)) return feedJson({ error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isInteger(requested) ? requested : 100;
  const updatedAt = Number(url.searchParams.get("updatedAt") ?? "0");
  const repoKey = url.searchParams.get("repoKey") ?? "";
  try {
    return feedJson(await reconcileFeedCatalog(limit, { updatedAt: Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? updatedAt : 0, repoKey }));
  } catch (error) {
    return feedJson({ error: "feed_unavailable", message: error instanceof Error ? error.message : "Feed reconciliation failed." }, { status: 503 });
  }
}

export const GET = reconcile;
export const POST = reconcile;
