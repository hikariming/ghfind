import { EDITORIAL_X_ACCOUNTS } from "@/config/x-accounts";
import { selectCacheStore } from "@/lib/cache-store";
import { getGoProfileCardPresentation } from "@/lib/go-profile.server";
import {
  X_MIN_DEV_SCORE,
  gatePost,
  mergePosts,
  normalizeHandle,
  parsePost,
  type XAccount,
  type XRejection,
  type XTimeline,
} from "@/lib/stream/x";
import { TIER_KEY } from "@/lib/tier";

/**
 * Storage and ingest for the curated X timeline. One KV document per
 * deployment (dev and production have separate GHFIND_CACHE namespaces), so
 * no D1 migration and one write per ingest batch.
 */

const KEY = "x-timeline:v1";
const TTL_SECONDS = 30 * 86_400;
const MAX_ACCOUNTS_PER_BATCH = 50;
const MAX_POSTS_PER_BATCH = 200;

const EDITORIAL = new Map(EDITORIAL_X_ACCOUNTS.map((entry) => [entry.handle.toLowerCase(), entry]));

function store() {
  // KV only: the timeline is not worth a Redis round trip where KV is off.
  return selectCacheStore(null);
}

export async function readXTimeline(): Promise<XTimeline | null> {
  const kv = store();
  if (!kv) return null;
  try {
    return await kv.get<XTimeline>(KEY);
  } catch (error) {
    console.error("x_timeline.read_failed", error);
    return null;
  }
}

async function ghfindScore(github: string): Promise<XAccount["ghfind"]> {
  try {
    const card = await getGoProfileCardPresentation(github);
    if (!card) return null;
    return { score: Math.round(card.detail.final_score), tier: TIER_KEY[card.detail.tier] ?? "npc" };
  } catch {
    return null;
  }
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function avatar(value: unknown): string | null {
  const url = str(value, 500);
  return url && /^https:\/\/pbs\.twimg\.com\//.test(url) ? url : null;
}

/** Editorial entries plus score-gated developers; unknown accounts are refused. */
async function admitAccounts(input: unknown[], previous: XAccount[]): Promise<{ accounts: Map<string, XAccount>; refused: string[] }> {
  const accounts = new Map(previous.map((account) => [account.handle, account]));
  for (const entry of EDITORIAL_X_ACCOUNTS) {
    const handle = entry.handle.toLowerCase();
    if (!accounts.has(handle)) {
      accounts.set(handle, {
        handle,
        name: entry.handle,
        category: entry.category,
        github: entry.github ?? null,
        talentId: entry.talentId ?? null,
        verified: false,
        avatarUrl: null,
        note: null,
        ghfind: null,
        source: "editorial",
      });
    }
  }

  const refused: string[] = [];
  for (const raw of input.slice(0, MAX_ACCOUNTS_PER_BATCH)) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const handle = normalizeHandle(record.handle);
    if (!handle) continue;
    const editorial = EDITORIAL.get(handle);
    const github = editorial?.github ?? str(record.github, 39)?.replace(/^@/, "") ?? null;
    const ghfind = github ? await ghfindScore(github) : null;
    if (!editorial && (!ghfind || ghfind.score < X_MIN_DEV_SCORE)) {
      refused.push(handle);
      accounts.delete(handle);
      continue;
    }
    const current = accounts.get(handle);
    accounts.set(handle, {
      handle,
      name: str(record.name, 60) ?? current?.name ?? handle,
      category: editorial?.category ?? "developer",
      github,
      talentId: editorial?.talentId ?? str(record.talentId, 64) ?? current?.talentId ?? null,
      verified: record.verified === true,
      avatarUrl: avatar(record.avatarUrl) ?? current?.avatarUrl ?? null,
      note: null,
      ghfind: ghfind ?? current?.ghfind ?? null,
      source: editorial ? "editorial" : "score",
    });
  }
  // Editorial entries removed from the allowlist lose their place too.
  for (const [handle, account] of accounts) {
    if (account.source === "editorial" && !EDITORIAL.has(handle)) accounts.delete(handle);
  }
  return { accounts, refused };
}

export type XIngestResult = {
  accepted: number;
  updated: number;
  rejected: XRejection[];
  refusedAccounts: string[];
  stored: { accounts: number; posts: number };
  dryRun: boolean;
};

export async function ingestXTimeline(body: unknown, options: { dryRun: boolean; now?: number }): Promise<XIngestResult | null> {
  const kv = store();
  if (!kv) return null;
  const now = options.now ?? Date.now();
  const payload = (body && typeof body === "object" ? body : {}) as { accounts?: unknown; posts?: unknown };
  const previous = (await readXTimeline()) ?? { accounts: [], posts: [], updatedAt: 0 };
  const { accounts, refused } = await admitAccounts(Array.isArray(payload.accounts) ? payload.accounts : [], previous.accounts);

  const rejected: XRejection[] = [];
  const accepted = [];
  let updated = 0;
  const seen = new Set(previous.posts.map((post) => post.id));
  for (const raw of (Array.isArray(payload.posts) ? payload.posts : []).slice(0, MAX_POSTS_PER_BATCH)) {
    const post = parsePost(raw);
    const id = raw && typeof raw === "object" && "id" in raw ? String((raw as { id: unknown }).id) : "";
    if (!post) {
      rejected.push({ id, reason: "invalid" });
      continue;
    }
    const reason = gatePost(post, accounts, now);
    if (reason) {
      rejected.push({ id: post.id, reason });
      continue;
    }
    // A post already stored is accepted again: that refreshes its X metrics.
    if (seen.has(post.id)) updated += 1;
    accepted.push(post);
  }

  // Posts whose account is no longer admitted leave with it.
  const kept = previous.posts.filter((post) => accounts.has(post.handle));
  const posts = mergePosts(kept, accepted, now);
  const next: XTimeline = { accounts: [...accounts.values()], posts, updatedAt: now };
  if (!options.dryRun) await kv.set(KEY, next, TTL_SECONDS);
  return {
    accepted: accepted.length - updated,
    updated,
    rejected,
    refusedAccounts: refused,
    stored: { accounts: next.accounts.length, posts: posts.length },
    dryRun: options.dryRun,
  };
}

/** Moderation: drop one post, or every post from one account. */
export async function removeFromXTimeline(target: { id?: string; handle?: string }): Promise<number | null> {
  const kv = store();
  if (!kv) return null;
  const current = await readXTimeline();
  if (!current) return 0;
  const handle = target.handle ? normalizeHandle(target.handle) : null;
  const posts = current.posts.filter((post) => post.id !== target.id && post.handle !== handle);
  const removed = current.posts.length - posts.length;
  if (removed > 0) await kv.set(KEY, { ...current, posts, updatedAt: Date.now() }, TTL_SECONDS);
  return removed;
}
