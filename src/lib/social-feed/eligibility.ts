import { createHash } from "node:crypto";
import { createClient, type Client } from "@libsql/client/web";
import { d1AsLibsqlClient, getD1Binding } from "@/lib/d1-client";
import { FEED_MINIMUM_SCORE, FEED_PUBLICATION_POLICY_VERSION, FEED_X_CURATED_POLICY_VERSION, SocialFeedError, type FeedActor, type PublicationEvidence, type PublishingCapabilities } from "./contract";

export interface PublishingScoreRecord {
  username: string;
  github_user_id: string | null;
  final_score: number;
  score_version: string | null;
  score_source_collection_version: string | null;
  score_source_snapshot_hash: string | null;
  hidden: number;
}
export type ScoreReader = (login: string) => Promise<PublishingScoreRecord | null>;

function coreDatabase(): Client {
  const binding = getD1Binding();
  if (binding) return d1AsLibsqlClient(binding);
  const url = process.env.TURSO_DATABASE_URL;
  if (url) return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  throw new SocialFeedError("score_unavailable", 503);
}

const SCORE_WITH_IDENTITY = `SELECT s.username, s.final_score, s.score_version, s.score_source_collection_version,
  s.score_source_snapshot_hash, s.hidden, r.snapshot
  FROM scores s LEFT JOIN public_scan_runs r ON r.id=(
    SELECT source.id FROM public_scan_runs source
    WHERE source.username=s.username AND source.snapshot_hash=s.score_source_snapshot_hash
      AND source.collection_version=s.score_source_collection_version
      AND source.state='complete_public' AND source.coverage='complete_public'
    ORDER BY source.completed_at DESC, source.id DESC LIMIT 1
  )`;

/** Read identity only from the hash-verified, server-collected scoring snapshot.
 * Older Go collectors stored the stable numeric ID in GitHub's avatar URL.
 * Never substitute the current profile/session avatar or a handle-only lookup.
 */
export function githubIdentityFromSnapshot(snapshot: unknown, hash: unknown, login: string): string | null {
  if (typeof snapshot !== "string" || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) ||
      createHash("sha256").update(snapshot).digest("hex") !== hash) return null;
  try {
    const value: unknown = JSON.parse(snapshot);
    if (!value || typeof value !== "object" || !("metrics" in value) ||
        !value.metrics || typeof value.metrics !== "object") return null;
    const metrics = value.metrics;
    if (!("username" in metrics) || typeof metrics.username !== "string" || metrics.username.toLowerCase() !== login.toLowerCase()) return null;
    if ("github_user_id" in metrics && metrics.github_user_id != null) {
      return typeof metrics.github_user_id === "string" && /^[1-9]\d*$/.test(metrics.github_user_id) ? metrics.github_user_id : null;
    }
    if (!("avatar_url" in metrics) || typeof metrics.avatar_url !== "string") return null;
    const avatar = new URL(metrics.avatar_url);
    if (avatar.origin !== "https://avatars.githubusercontent.com" || avatar.username || avatar.password) return null;
    return /^\/u\/([1-9]\d*)$/.exec(avatar.pathname)?.[1] ?? null;
  } catch { return null; }
}
function scoreRecord(row: Record<string, unknown>): PublishingScoreRecord {
  const username = String(row.username);
  return {
    username, github_user_id: githubIdentityFromSnapshot(row.snapshot, row.score_source_snapshot_hash, username),
    final_score: Number(row.final_score), hidden: Number(row.hidden),
    score_version: typeof row.score_version === "string" ? row.score_version : null,
    score_source_collection_version: typeof row.score_source_collection_version === "string" ? row.score_source_collection_version : null,
    score_source_snapshot_hash: typeof row.score_source_snapshot_hash === "string" ? row.score_source_snapshot_hash : null,
  };
}

/** Display-only score for author cards: final_score without joining public_scan_runs.snapshot.
 * Snapshot hash verification stays on the write path (requirePublication / publicationFromScore).
 */
export const readDisplayScore: ScoreReader = async (login) => {
  try {
    const result = await coreDatabase().execute({
      sql: `SELECT s.username, s.final_score, s.score_version, s.score_source_collection_version,
        s.score_source_snapshot_hash, s.hidden FROM scores s WHERE s.username=? LIMIT 1`,
      args: [login.toLowerCase()],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      username: String(row.username),
      github_user_id: null,
      final_score: Number(row.final_score),
      hidden: Number(row.hidden),
      score_version: typeof row.score_version === "string" ? row.score_version : null,
      score_source_collection_version: typeof row.score_source_collection_version === "string" ? row.score_source_collection_version : null,
      score_source_snapshot_hash: typeof row.score_source_snapshot_hash === "string" ? row.score_source_snapshot_hash : null,
    };
  } catch {
    throw new SocialFeedError("score_unavailable", 503);
  }
};

/** An authorization read must not use the public API's stale/legacy fallback. */
export const readPublishingScore: ScoreReader = async (login) => {
  try {
    const result = await coreDatabase().execute({ sql: `${SCORE_WITH_IDENTITY} WHERE s.username=? LIMIT 1`, args: [login.toLowerCase()] });
    return result.rows[0] ? scoreRecord(result.rows[0]) : null;
  } catch {
    throw new SocialFeedError("score_unavailable", 503);
  }
};

export function publicationFromScore(login: string, score: PublishingScoreRecord | null, githubUserId: string): PublicationEvidence {
  if (!score || score.hidden !== 0 || score.username.toLowerCase() !== login.toLowerCase()) {
    throw new SocialFeedError("score_required", 403);
  }
  // Publishing uses the last persisted score, not the scan cache freshness policy.
  // Preserve its original version and provenance instead of triggering a new assessment.
  if (!score.score_version || !score.score_source_collection_version ||
      !score.score_source_snapshot_hash || !/^[a-f0-9]{64}$/.test(score.score_source_snapshot_hash)) {
    throw new SocialFeedError("score_outdated", 403);
  }
  if (!Number.isFinite(score.final_score) || score.final_score < 0 || score.final_score > 100) throw new SocialFeedError("score_unavailable", 503);
  // Never round 59.96 into publishing eligibility.
  if (score.final_score < FEED_MINIMUM_SCORE) throw new SocialFeedError("score_below_minimum", 403);
  if (!score.github_user_id) throw new SocialFeedError("score_identity_required", 403);
  if (score.github_user_id !== githubUserId) throw new SocialFeedError("score_identity_mismatch", 403);
  return {
    score: score.final_score,
    score_record_id: `${score.username.toLowerCase()}:${score.score_version}:${score.score_source_snapshot_hash}`,
    score_version: score.score_version,
    policy_version: FEED_PUBLICATION_POLICY_VERSION,
  };
}

export async function requirePublication(actor: FeedActor, readScore: ScoreReader = readPublishingScore): Promise<PublicationEvidence> {
  return publicationFromScore(actor.github_login, await readScore(actor.github_login), actor.github_user_id);
}
export async function publishingCapabilities(actor: FeedActor | null, readScore: ScoreReader = readPublishingScore): Promise<PublishingCapabilities> {
  const denied = (reason: string): PublishingCapabilities => ({ can_publish: false, can_reply: false, minimum_score: 60, reason });
  if (!actor) return denied("authentication_required");
  try {
    const publication = await requirePublication(actor, readScore);
    return { score: publication.score, can_publish: true, can_reply: true, minimum_score: 60, reason: null, policy_version: FEED_PUBLICATION_POLICY_VERSION };
  } catch (error) {
    return denied(error instanceof SocialFeedError ? error.code : "score_unavailable");
  }
}

/**
 * X posts come from curated, identity-reviewed accounts, so their score is provenance only.
 * A current eligible score is recorded when present; otherwise (no score, stale scan, missing
 * snapshot identity, low score or score storage unavailable) the post is labelled curated.
 * The placeholder score only satisfies the stored evidence shape and never authorizes native publishing.
 */
export async function xIngestPublication(login: string, githubUserId: string, readScore: ScoreReader = readPublishingScore): Promise<PublicationEvidence> {
  try {
    return publicationFromScore(login, await readScore(login), githubUserId);
  } catch (error) {
    if (!(error instanceof SocialFeedError)) throw error;
    return { score: FEED_MINIMUM_SCORE, score_record_id: `x-curated:${login.toLowerCase()}`, score_version: "unscored",
      policy_version: FEED_X_CURATED_POLICY_VERSION };
  }
}
