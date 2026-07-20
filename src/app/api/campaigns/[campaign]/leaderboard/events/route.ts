import { NextRequest } from "next/server";
import { campaignSlug } from "@/lib/campaigns";
import type { CampaignSlug } from "@/lib/campaigns";
import { getCampaignLeaderboardRevision } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REVISION_POLL_MS = 2_000;
const STREAM_LIFETIME_MS = 55_000;
const MAX_STREAMS_PER_CAMPAIGN = 64;
const STREAM_CAP_RETRY_AFTER_SECONDS = 10;

type RevisionListener = (revision: number) => void;

interface RevisionChannel {
  campaign: CampaignSlug;
  interval: ReturnType<typeof setInterval> | undefined;
  listeners: Set<RevisionListener>;
  polling: boolean;
  ready: Promise<number | null>;
  revision: number | null;
}

const revisionChannels = new Map<CampaignSlug, RevisionChannel>();

function channelFor(campaign: CampaignSlug): RevisionChannel {
  const existing = revisionChannels.get(campaign);
  if (existing) return existing;

  const channel: RevisionChannel = {
    campaign,
    interval: undefined,
    listeners: new Set(),
    polling: false,
    ready: Promise.resolve(null),
    revision: null,
  };
  channel.ready = getCampaignLeaderboardRevision(campaign).then((revision) => {
    channel.revision = revision;
    if (revision === null && revisionChannels.get(campaign) === channel) {
      revisionChannels.delete(campaign);
    }
    return revision;
  });
  revisionChannels.set(campaign, channel);
  return channel;
}

async function pollChannel(channel: RevisionChannel): Promise<void> {
  if (channel.polling) return;
  channel.polling = true;
  try {
    const nextRevision = await getCampaignLeaderboardRevision(channel.campaign);
    if (nextRevision === null || nextRevision === channel.revision) return;
    channel.revision = nextRevision;
    for (const listener of channel.listeners) listener(nextRevision);
  } catch {
    // Keep subscribers alive; EventSource and the 2-minute fallback recover.
  } finally {
    channel.polling = false;
  }
}

function subscribe(channel: RevisionChannel, listener: RevisionListener): (() => void) | null {
  if (channel.listeners.size >= MAX_STREAMS_PER_CAMPAIGN) return null;
  channel.listeners.add(listener);
  channel.interval ??= setInterval(() => void pollChannel(channel), REVISION_POLL_MS);

  return () => {
    channel.listeners.delete(listener);
    if (channel.listeners.size > 0) return;
    if (channel.interval) clearInterval(channel.interval);
    channel.interval = undefined;
    if (revisionChannels.get(channel.campaign) === channel) {
      revisionChannels.delete(channel.campaign);
    }
  };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ campaign: string }> },
) {
  const { campaign: rawCampaign } = await context.params;
  const campaign = campaignSlug(rawCampaign);
  if (!campaign) return new Response("Not found", { status: 404 });

  const channel = channelFor(campaign);
  const initialRevision = await channel.ready;
  if (initialRevision === null) {
    return new Response("Live updates unavailable", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "15" },
    });
  }

  const encoder = new TextEncoder();
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const listener: RevisionListener = (revision) => {
    if (closed || !controllerRef) return;
    controllerRef.enqueue(encoder.encode(`data: ${revision}\n\n`));
  };
  const unsubscribe = subscribe(channel, listener);
  if (!unsubscribe) {
    return new Response("Too many live streams", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(STREAM_CAP_RETRY_AFTER_SECONDS),
      },
    });
  }

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (lifetime) clearTimeout(lifetime);
    unsubscribe();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      lifetime = setTimeout(() => {
        cleanup();
        controller.close();
      }, STREAM_LIFETIME_MS);
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
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
