// Pure, parameterized core statements shared by independent Workers and the
// assessment finalizer. This module has no Next, libsql client or binding import.
export interface CoreSourceStatement { sql: string; args: (string | number)[] }

// The core DB assigns a monotonically increasing sequence used as sourceVersion
// downstream. The message carries references, not unbounded assessment JSON.
export function assessmentOutboxStatement(analysisId: string, now: number): CoreSourceStatement {
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
): CoreSourceStatement {
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

export interface FeedSourceReplayCommand {
  sequence: number;
  commandId: string;
  operator: string;
  reason: string;
  now: number;
}

// Shared by the Workers operator capability and the standalone core helper.
// These fixed statements are a single core transaction, never arbitrary SQL RPC.
export function sourceReplayStatements(input: FeedSourceReplayCommand): CoreSourceStatement[] {
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

