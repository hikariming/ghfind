import { listPendingFeedTagProposals, reviewFeedTagProposal } from "@/lib/feed";
import { feedErrorResponse, feedJson, feedJsonBody, internalFeedAuthorized } from "@/lib/feed-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!internalFeedAuthorized(request)) return feedJson({ error: "forbidden" }, { status: 403 });
  try {
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "100");
    return feedJson({ proposals: await listPendingFeedTagProposals(Number.isInteger(limit) ? limit : 100) });
  } catch (error) {
    return feedErrorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!internalFeedAuthorized(request)) return feedJson({ error: "forbidden" }, { status: 403 });
  try {
    const body = await feedJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return feedJson({ error: "invalid_body" }, { status: 400 });
    const value = body as Record<string, unknown>;
    if (typeof value.proposalId !== "string" || !["create", "map", "reject"].includes(value.action as string) || typeof value.reason !== "string") {
      return feedJson({ error: "invalid_body", message: "proposalId, action and reason are required." }, { status: 400 });
    }
    return feedJson(await reviewFeedTagProposal({
      proposalId: value.proposalId,
      action: value.action as "create" | "map" | "reject",
      reviewer: "machine-admin",
      reason: value.reason,
      canonicalTagId: typeof value.canonicalTagId === "string" ? value.canonicalTagId : undefined,
    }));
  } catch (error) {
    return feedErrorResponse(error);
  }
}
