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

// Fixed SQL selectors keep POST intent separate from user-controlled payloads.
// The active-key form is used in the SAME batch as run creation/deduplication.
export function appSubmissionReceiptStatement(
  identity: { analysisId: string } | { activeKey: string },
  now: number,
): { sql: string; args: InValue[] } {
  const byId = "analysisId" in identity;
  return {
    sql: `INSERT INTO feed_submission_receipts
      (id, analysis_id, requested_repo_key, source_kind, submitted_at, evidence_ref)
      SELECT 'app:' || id, id, lower(repo_key), 'app_submission', ?, 'POST /api/project-analyses'
      FROM project_analysis_runs WHERE ${byId ? "id" : "active_key"} = ?
      ON CONFLICT(analysis_id) DO NOTHING`,
    args: [now, byId ? identity.analysisId : identity.activeKey],
  };
}

// Explicit reuse of a completed run also records app intent. Historical
// completion and background reconciliation never call this on their own.
export async function recordAppSubmission(db: Client, analysisId: string, now = Date.now()): Promise<void> {
  if (!feedSourceOutboxEnabled()) return;
  await db.batch([
    appSubmissionReceiptStatement({ analysisId }, now),
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

export interface FeedSourceReplayCommand {
  sequence: number;
  commandId: string;
  operator: string;
  reason: string;
  now: number;
}

// Shared by the Workers operator capability and the standalone core helper.
// These fixed statements are a single core transaction, never arbitrary SQL RPC.
export function sourceReplayStatements(input: FeedSourceReplayCommand): {sql:string;args:InValue[]}[] {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
      !Number.isSafeInteger(input.now) || input.now < 0 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.commandId) ||
      !input.operator.trim() || input.operator.length > 100 ||
      [...input.reason.trim()].length < 8 || input.reason.length > 500) {
    throw new Error("Invalid source replay command.");
  }
  const command=crypto.randomUUID();
  return [
    {
      sql:`INSERT INTO feed_source_operator_guards(id,identity_ok,eligible_ok) VALUES(?,
        CASE WHEN NOT EXISTS(SELECT 1 FROM feed_source_operator_commands WHERE command_id=?
          AND (sequence<>? OR operator<>? OR reason<>?)) THEN 1 ELSE 0 END,
        CASE WHEN EXISTS(SELECT 1 FROM feed_source_operator_commands WHERE command_id=?)
          OR EXISTS(SELECT 1 FROM feed_source_outbox WHERE sequence=? AND status='failed') THEN 1 ELSE 0 END)`,
      args:[command,input.commandId,input.sequence,input.operator,input.reason,input.commandId,input.sequence],
    },
    {
      sql:`UPDATE feed_source_outbox SET status='pending',attempts=0,available_at=?,lease_token=NULL,
        lease_expires_at=NULL,delivered_at=NULL,last_error=NULL,replay_count=replay_count+1,replay_reason=?,replayed_at=?
        WHERE sequence=? AND NOT EXISTS(SELECT 1 FROM feed_source_operator_commands WHERE command_id=?)`,
      args:[input.now,input.reason,input.now,input.sequence,input.commandId],
    },
    {
      sql:`INSERT INTO feed_source_operator_commands(command_id,sequence,event_id,source_hash,operator,reason,accepted_at)
        SELECT ?,sequence,event_id,source_hash,?,?,? FROM feed_source_outbox WHERE sequence=? ON CONFLICT(command_id) DO NOTHING`,
      args:[input.commandId,input.operator,input.reason,input.now,input.sequence],
    },
    {sql:"DELETE FROM feed_source_operator_guards WHERE id=?",args:[command]},
  ];
}

// Success means durable command acceptance; an exact retry remains accepted
// after subsequent leasing/delivery without resetting that later state.
export async function replayFeedSourceEvent(db: Client, input: FeedSourceReplayCommand): Promise<boolean> {
  await db.batch(sourceReplayStatements(input), "write");
  return true;
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
