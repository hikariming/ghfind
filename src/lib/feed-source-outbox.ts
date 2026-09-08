import type { Client } from "@libsql/client/web";
import { appSubmissionReceiptStatement, assessmentOutboxStatement, sourceReplayStatements, type FeedSourceReplayCommand } from "../../platform/shared/feed-source-statements";
export { appSubmissionReceiptStatement, assessmentOutboxStatement, sourceReplayStatements, type FeedSourceReplayCommand } from "../../platform/shared/feed-source-statements";

export function feedSourceOutboxEnabled(): boolean {
  return process.env.FEED_SOURCE_OUTBOX_ENABLED === "true";
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
