import { splitRepoKey } from "./map";
import type { DiscoverCard, DiscoverPage } from "./types";
import type { FeedWrite } from "./events";

export class DiscoverClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DiscoverClientError";
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asCard(value: unknown): DiscoverCard | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<DiscoverCard>;
  if (typeof row.repoKey !== "string" || typeof row.summary !== "string") return null;
  return {
    repoKey: row.repoKey.toLowerCase(),
    ownerLogin: String(row.ownerLogin ?? splitRepoKey(row.repoKey).ownerLogin),
    name: String(row.name ?? splitRepoKey(row.repoKey).name),
    summary: row.summary,
    language: typeof row.language === "string" ? row.language : null,
    tags: Array.isArray(row.tags)
      ? row.tags.flatMap((tag) => {
          if (!tag || typeof tag !== "object") return [];
          const item = tag as { id?: unknown; label?: unknown };
          if (typeof item.id !== "string" || typeof item.label !== "string") return [];
          return [{ id: item.id, label: item.label }];
        })
      : [],
    productScore: Number(row.productScore) || 0,
    confidence: Number(row.confidence) || 0,
    communityStrength: typeof row.communityStrength === "number" ? row.communityStrength : null,
    canonicalUrl: typeof row.canonicalUrl === "string" ? row.canonicalUrl : `https://github.com/${row.repoKey}`,
    analysisId: typeof row.analysisId === "string" ? row.analysisId : null,
    impressionToken: typeof row.impressionToken === "string" ? row.impressionToken : null,
    source: row.source === "feed" ? "feed" : "public",
    verificationLevel: typeof row.verificationLevel === "string" ? row.verificationLevel : null,
  };
}

export async function fetchPublicPage(input: {
  limit?: number;
  offset?: number;
  locale: string;
  board?: "treasure" | "classic" | "all";
}): Promise<DiscoverPage> {
  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;
  const board = input.board ?? "treasure";
  const response = await fetch(
    `/api/discover/public?limit=${limit}&offset=${offset}&locale=${encodeURIComponent(input.locale)}&board=${board}`,
    { credentials: "same-origin" },
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw new DiscoverClientError(String(body.error ?? "feed_unavailable"), response.status, String(body.message ?? "Public discover is unavailable."));
  }
  const items = Array.isArray(body.items) ? body.items.flatMap((item) => asCard(item) ?? []) : [];
  return {
    items,
    nextCursor: null,
    nextOffset: typeof body.nextOffset === "number" ? body.nextOffset : null,
    source: "public",
    degraded: Array.isArray(body.degraded) ? body.degraded.map(String) : [],
    requestId: typeof body.requestId === "string" ? body.requestId : null,
  };
}

export async function fetchFeedPage(input: {
  limit?: number;
  cursor?: string | null;
  locale: string;
}): Promise<DiscoverPage> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await fetch(`/api/feed/projects?${params}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await readJson(response);
  if (response.status === 410 || body.error === "feed_cursor_expired") {
    throw new DiscoverClientError("feed_cursor_expired", 410, String(body.message ?? "Feed cursor expired."));
  }
  if (response.status === 401) {
    throw new DiscoverClientError("authentication_required", 401, "authentication_required");
  }
  if (!response.ok) {
    throw new DiscoverClientError(String(body.error ?? "feed_unavailable"), response.status, String(body.message ?? "Feed is unavailable."));
  }
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as { project?: unknown; impressionToken?: unknown };
    if (!row.project || typeof row.project !== "object") return [];
    const project = row.project as Record<string, unknown>;
    return [asCard({
      repoKey: project.repoKey,
      ownerLogin: project.ownerLogin,
      name: project.name,
      summary: project.summary,
      language: project.language,
      tags: Array.isArray(project.tags)
        ? project.tags.map((tag) => {
            const item = tag as { id?: string; labelZh?: string; labelEn?: string };
            const zh = input.locale.toLowerCase().startsWith("zh");
            return { id: item.id, label: zh ? item.labelZh : item.labelEn };
          })
        : [],
      productScore: project.productScore,
      confidence: project.confidence,
      canonicalUrl: project.canonicalUrl,
      impressionToken: row.impressionToken,
      source: "feed",
      verificationLevel: project.verificationLevel,
    })].flatMap((card) => card ?? []);
  });
  return {
    items,
    nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
    nextOffset: null,
    source: "feed",
    degraded: Array.isArray(body.degraded) ? body.degraded.map(String) : [],
    requestId: typeof body.requestId === "string" ? body.requestId : null,
  };
}

export async function commitFeedWrites(writes: FeedWrite[]): Promise<void> {
  const events: Array<Record<string, unknown>> = [];
  for (const write of writes) {
    if (write.kind === "state") {
      const { ownerLogin, name } = splitRepoKey(write.repoKey);
      const response = await fetch(`/api/feed/projects/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(name)}/state`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ saved: write.saved, impressionToken: write.impressionToken }),
      });
      if (!response.ok) {
        const body = await readJson(response);
        throw new DiscoverClientError(String(body.error ?? "feed_unavailable"), response.status, String(body.message ?? "Could not update Feed state."));
      }
    } else {
      events.push({
        id: write.eventId,
        type: write.type,
        repoKey: write.repoKey,
        impressionToken: write.impressionToken,
        occurredAt: new Date().toISOString(),
      });
    }
  }
  if (events.length === 0) return;
  const response = await fetch("/api/feed/events", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: events.slice(0, 50) }),
  });
  if (!response.ok && response.status !== 202) {
    const body = await readJson(response);
    throw new DiscoverClientError(String(body.error ?? "invalid_events"), response.status, String(body.message ?? "Could not append Feed events."));
  }
}
