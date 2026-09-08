import type { Client, InValue } from "@libsql/client/web";

export function feedSourceOutboxEnabled(): boolean {
  return process.env.FEED_SOURCE_OUTBOX_ENABLED === "true";
}

// The core DB assigns a monotonically increasing sequence used as sourceVersion
// downstream. The message carries references, not unbounded assessment JSON.
export function assessmentOutboxStatement(analysisId: string, now: number): { sql: string; args: InValue[] } {
  return {
    sql: `INSERT INTO feed_source_outbox (
      event_id, aggregate_key, kind, analysis_id, receipt_id, source_hash,
      occurred_at, available_at
    ) SELECT 'assessment.completed:' || r.id || ':' || r.analysis_sha256,
      lower(r.repo_key), 'assessment.completed', r.id, s.id, r.analysis_sha256, ?, ?
      FROM project_analysis_runs r
      JOIN feed_submission_receipts s ON s.analysis_id = r.id
      JOIN project_assessments a ON a.repo_key = r.repo_key AND a.latest_analysis_id = r.id
      WHERE r.id = ? AND r.status = 'completed' AND r.analysis_sha256 IS NOT NULL
      ON CONFLICT(event_id) DO NOTHING`,
    args: [now, now, analysisId],
  };
}

// Only the explicit submission route calls this. No caller-supplied source kind,
// owner identity or authorization claim is trusted. Reuse of a completed run is
// a new explicit submission and therefore must pass this seam as well.
export async function recordAppSubmission(db: Client, analysisId: string, now = Date.now()): Promise<void> {
  if (!feedSourceOutboxEnabled()) return;
  await db.batch([
    {
      sql: `INSERT INTO feed_submission_receipts
        (id, analysis_id, requested_repo_key, source_kind, submitted_at, evidence_ref)
        SELECT 'app:' || id, id, lower(repo_key), 'app_submission', ?, 'POST /api/project-analyses'
        FROM project_analysis_runs WHERE id = ?
        ON CONFLICT(analysis_id) DO NOTHING`,
      args: [now, analysisId],
    },
    assessmentOutboxStatement(analysisId, now),
  ], "write");
}

export interface FeedSourceEvent {
  contractVersion: 1;
  eventId: string;
  aggregateKey: string;
  sourceVersion: number;
  kind: "assessment.completed";
  analysisId: string;
  receiptId: string;
  sourceHash: string;
  occurredAt: number;
}

export interface LeasedFeedSourceEvent extends FeedSourceEvent {
  leaseToken: string;
  attempts: number;
}

// Indexed finite claim, not a catalog scan. Claim and lease-token assignment
// are one SQL mutation, allowing concurrent relays without duplicate ownership.
export async function claimFeedSourceEvents(db: Client, input: { limit: number; leaseToken: string; now: number }): Promise<LeasedFeedSourceEvent[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !input.leaseToken || input.leaseToken.length > 128) throw new Error("Invalid source claim.");
  // A worker can disappear on its final attempt. Persist exhaustion instead of
  // leaving an unclaimable lease forever; this is also an indexed bounded sweep.
  await db.execute({
    sql: `UPDATE feed_source_outbox SET status = 'failed', last_error = 'lease_exhausted',
      lease_token = NULL, lease_expires_at = NULL
      WHERE sequence IN (SELECT sequence FROM feed_source_outbox
        WHERE status = 'leased' AND attempts >= 10 AND lease_expires_at <= ?
        ORDER BY sequence LIMIT 100)`,
    args: [input.now],
  });
  const result = await db.execute({
    sql: `UPDATE feed_source_outbox SET status = 'leased', lease_token = ?,
      lease_expires_at = ?, attempts = attempts + 1
      WHERE sequence IN (
        SELECT sequence FROM feed_source_outbox
        WHERE attempts < 10 AND ((status = 'pending' AND available_at <= ?) OR
          (status = 'leased' AND lease_expires_at <= ?))
        ORDER BY sequence LIMIT ?
      ) RETURNING *`,
    args: [input.leaseToken, input.now + 60_000, input.now, input.now, input.limit],
  });
  return result.rows.map<LeasedFeedSourceEvent>((row) => ({
    contractVersion: 1,
    eventId: String(row.event_id), aggregateKey: String(row.aggregate_key), sourceVersion: Number(row.sequence),
    kind: "assessment.completed", analysisId: String(row.analysis_id), receiptId: String(row.receipt_id),
    sourceHash: String(row.source_hash), occurredAt: Number(row.occurred_at),
    leaseToken: input.leaseToken, attempts: Number(row.attempts),
  })).sort((a, b) => a.sourceVersion - b.sourceVersion);
}

// Replay is an operator command with a fresh audit reference, never an automatic
// unbounded retry. Event identity/sourceVersion remain unchanged.
export async function replayFeedSourceEvent(db: Client, input: { sequence: number; reason: string; now: number }): Promise<boolean> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || !input.reason.trim() || input.reason.length > 256) throw new Error("Invalid replay request.");
  const result = await db.execute({
    sql: `UPDATE feed_source_outbox SET status = 'pending', attempts = 0,
      available_at = ?, lease_token = NULL, lease_expires_at = NULL,
      replay_count = replay_count + 1, replay_reason = ?, replayed_at = ?
      WHERE sequence = ? AND status = 'failed'`,
    args: [input.now, input.reason, input.now, input.sequence],
  });
  return result.rowsAffected === 1;
}

export async function finishFeedSourceDelivery(db: Client, input: {
  sequence: number; leaseToken: string; now: number; delivered: boolean; errorCode?: "queue_unavailable" | "invalid_event";
}): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE feed_source_outbox SET
      status = CASE WHEN ? = 1 THEN 'delivered' WHEN attempts >= 10 THEN 'failed' ELSE 'pending' END,
      delivered_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
      available_at = ? + min(300000, 1000 * (1 << attempts)),
      last_error = ?, lease_token = NULL, lease_expires_at = NULL
      WHERE sequence = ? AND status = 'leased' AND lease_token = ? AND lease_expires_at > ?`,
    args: [input.delivered ? 1 : 0, input.delivered ? 1 : 0, input.now, input.now,
      input.delivered ? null : input.errorCode ?? "queue_unavailable", input.sequence, input.leaseToken, input.now],
  });
  return result.rowsAffected === 1;
}
