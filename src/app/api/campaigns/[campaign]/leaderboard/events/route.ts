import { NextRequest } from "next/server";
import { campaignSlug } from "@/lib/campaigns";
import { getCampaignLeaderboardRevision } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REVISION_POLL_MS = 2_000;
const STREAM_LIFETIME_MS = 55_000;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ campaign: string }> },
) {
  const { campaign: rawCampaign } = await context.params;
  const campaign = campaignSlug(rawCampaign);
  if (!campaign) return new Response("Not found", { status: 404 });

  const initialRevision = await getCampaignLeaderboardRevision(campaign);
  if (initialRevision === null) {
    return new Response("Live updates unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "15" },
    });
  }

  const encoder = new TextEncoder();
  let revision = initialRevision;
  let polling = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (interval) clearInterval(interval);
        if (lifetime) clearTimeout(lifetime);
      };
      const checkRevision = async () => {
        if (polling) return;
        polling = true;
        try {
          const nextRevision = await getCampaignLeaderboardRevision(campaign);
          if (nextRevision !== null && nextRevision !== revision) {
            revision = nextRevision;
            controller.enqueue(encoder.encode(`data: ${revision}\n\n`));
          }
        } catch {
          // Keep the stream alive; EventSource and the 2-minute fallback recover.
        } finally {
          polling = false;
        }
      };

      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      interval = setInterval(() => void checkRevision(), REVISION_POLL_MS);
      lifetime = setTimeout(() => {
        cleanup();
        controller.close();
      }, STREAM_LIFETIME_MS);
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      if (interval) clearInterval(interval);
      if (lifetime) clearTimeout(lifetime);
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
