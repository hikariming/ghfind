import { z } from "zod";
import { BridgeError, hash } from "./contract";

const id = z.string().min(1).max(300);
const integer = z.number().int().safe();
export const sourceEventSchema = z.strictObject({
  contractVersion: z.literal(1),
  eventId: id,
  aggregateKey: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9_.-]{1,100}$/),
  sourceVersion: integer.positive(),
  kind: z.literal("assessment.completed"),
  analysisId: id,
  receiptId: id,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  occurredAt: integer.nonnegative(),
});
export type SourceEvent = z.infer<typeof sourceEventSchema>;
const sourceSchemas = {
  health: z.strictObject({}),
  assessment: sourceEventSchema,
  claim: z.strictObject({
    limit: integer.min(1).max(100),
    leaseToken: z.string().min(1).max(128),
  }),
  finish: z.strictObject({
    sequence: integer.positive(),
    leaseToken: z.string().min(1).max(128),
    delivered: z.boolean(),
    errorCode: z.enum(["queue_unavailable", "invalid_event"]).optional(),
  }),
};
type OutboxRow = {
  sequence: number;
  event_id: string;
  aggregate_key: string;
  contract_version: 1;
  kind: "assessment.completed";
  analysis_id: string;
  receipt_id: string;
  source_hash: string;
  occurred_at: number;
  attempts: number;
};
function envelope(row: OutboxRow): SourceEvent {
  return {
    contractVersion: row.contract_version,
    eventId: row.event_id,
    aggregateKey: row.aggregate_key,
    sourceVersion: row.sequence,
    kind: row.kind,
    analysisId: row.analysis_id,
    receiptId: row.receipt_id,
    sourceHash: row.source_hash,
    occurredAt: row.occurred_at,
  };
}

// All facts are selected together from the core binding. Neither a caller's
// projection nor a queue envelope can confer submission/publication authority.
async function assessment(db: D1Database, event: SourceEvent): Promise<object> {
  type Row = OutboxRow & {
    source_kind: string;
    submitted_at: number;
    run_status: string;
    run_repo: string;
    analysis_json: string;
    analysis_sha256: string;
    latest_analysis_id: string;
    product_score: number;
    confidence: number;
    treasure_eligible: number;
    classic_eligible: number;
    resolved_commit_sha: string;
    analyzed_at: number;
    newer_sequence: number | null;
    newer_analysis_json: string | null;
    newer_analysis_sha256: string | null;
  };
  const row = await db
    .prepare(
      `SELECT o.*, s.source_kind, s.submitted_at,
    r.status AS run_status, r.repo_key AS run_repo, r.analysis_json, r.analysis_sha256,
    a.latest_analysis_id, a.product_score, a.confidence, a.treasure_eligible,
    a.classic_eligible, a.resolved_commit_sha, a.analyzed_at,
    CASE WHEN a.latest_analysis_id<>o.analysis_id THEN latest_run.analysis_json END AS newer_analysis_json,
    latest_run.analysis_sha256 AS newer_analysis_sha256,
    (SELECT max(n.sequence) FROM feed_source_outbox n
      JOIN project_analysis_runs nr ON nr.id=n.analysis_id AND nr.status='completed'
        AND nr.analysis_sha256=n.source_hash AND nr.repo_key=n.aggregate_key
      JOIN feed_submission_receipts ns ON ns.id=n.receipt_id AND ns.analysis_id=nr.id
      WHERE n.aggregate_key=o.aggregate_key AND n.analysis_id=a.latest_analysis_id
        AND n.sequence>o.sequence) AS newer_sequence
    FROM feed_source_outbox o
    JOIN feed_submission_receipts s ON s.id=o.receipt_id AND s.analysis_id=o.analysis_id
    JOIN project_analysis_runs r ON r.id=o.analysis_id
    JOIN project_assessments a ON a.repo_key=o.aggregate_key
    LEFT JOIN project_analysis_runs latest_run ON latest_run.id=a.latest_analysis_id
    WHERE o.sequence=?`,
    )
    .bind(event.sourceVersion)
    .first<Row>();
  if (!row) throw new BridgeError(404, "source_event_not_found");
  if (JSON.stringify(envelope(row)) !== JSON.stringify(event)) {
    throw new BridgeError(409, "source_identity_conflict");
  }
  if (
    row.run_status !== "completed" ||
    row.run_repo !== event.aggregateKey ||
    row.analysis_sha256 !== event.sourceHash ||
    !row.analysis_json ||
    new TextEncoder().encode(row.analysis_json).byteLength > 1024 * 1024 ||
    (await hash(row.analysis_json)) !== event.sourceHash
  ) {
    throw new BridgeError(409, "source_facts_invalid");
  }
  const result = { eventId: event.eventId, sourceVersion: event.sourceVersion };
  if (row.latest_analysis_id !== event.analysisId) {
    if (!row.newer_sequence)
      throw new BridgeError(409, "source_version_unavailable");
    // Stored hash columns alone cannot prove the replacement is recoverable.
    // Validate bytes selected in the same D1 read as its completed run/receipt
    // identity before telling the executor it may permanently complete old work.
    if (
      !row.newer_analysis_json ||
      new TextEncoder().encode(row.newer_analysis_json).byteLength >
        1024 * 1024 ||
      (await hash(row.newer_analysis_json)) !== row.newer_analysis_sha256
    ) {
      throw new BridgeError(409, "source_facts_invalid");
    }
    return { ...result, status: "superseded" };
  }
  return {
    ...result,
    status: "current",
    assessment: {
      repoKey: event.aggregateKey,
      latestAnalysisId: row.latest_analysis_id,
      productScore: row.product_score,
      confidence: row.confidence,
      treasureEligible: row.treasure_eligible === 1,
      classicEligible: row.classic_eligible === 1,
      resolvedCommitSha: row.resolved_commit_sha,
      analyzedAt: row.analyzed_at,
    },
    analysisJSON: row.analysis_json,
    receipt: {
      receiptId: row.receipt_id,
      sourceKind: row.source_kind,
      submittedAt: new Date(row.submitted_at).toISOString(),
    },
  };
}

// Claims are one indexed UPDATE RETURNING. The preceding bounded exhaustion
// sweep is independently idempotent; no multi-command transaction is implied.
async function claim(db: D1Database, limit: number, leaseToken: string) {
  const now = Date.now();
  await db
    .prepare(
      `UPDATE feed_source_outbox SET status='failed', last_error='lease_exhausted',
    lease_token=NULL, lease_expires_at=NULL WHERE sequence IN (
      SELECT sequence FROM feed_source_outbox WHERE status='leased' AND attempts>=10
      AND lease_expires_at<=? ORDER BY sequence LIMIT 100)`,
    )
    .bind(now)
    .run();
  const { results } = await db
    .prepare(
      `UPDATE feed_source_outbox
    SET status='leased',lease_token=?,lease_expires_at=?,attempts=attempts+1
    WHERE sequence IN (SELECT sequence FROM feed_source_outbox WHERE attempts<10
      AND ((status='pending' AND available_at<=?) OR (status='leased' AND lease_expires_at<=?))
      ORDER BY sequence LIMIT ?) RETURNING *`,
    )
    .bind(leaseToken, now + 60000, now, now, limit)
    .all<OutboxRow>();
  return {
    events: results
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({ ...envelope(row), leaseToken, attempts: row.attempts })),
  };
}

export async function handleSource(
  operation: string,
  raw: unknown,
  db: D1Database,
): Promise<object> {
  switch (operation) {
    case "health": {
      parse(sourceSchemas.health, raw);
      await db
        .prepare(
          `SELECT o.sequence,s.id FROM feed_source_outbox o
        LEFT JOIN feed_submission_receipts s ON s.id=o.receipt_id LIMIT 1`,
        )
        .all();
      return { ready: true, contractVersion: "1" };
    }
    case "assessment":
      return assessment(db, parse(sourceSchemas.assessment, raw));
    case "claim": {
      const input = parse(sourceSchemas.claim, raw);
      return claim(db, input.limit, input.leaseToken);
    }
    case "finish": {
      const input = parse(sourceSchemas.finish, raw),
        now = Date.now();
      const result = await db
        .prepare(
          `UPDATE feed_source_outbox SET
        status=CASE WHEN ?=1 THEN 'delivered' WHEN attempts>=10 THEN 'failed' ELSE 'pending' END,
        delivered_at=CASE WHEN ?=1 THEN ? ELSE NULL END,
        available_at=?+min(300000,1000*(1 << attempts)),last_error=?,
        lease_token=NULL,lease_expires_at=NULL
        WHERE sequence=? AND status='leased' AND lease_token=? AND lease_expires_at>?`,
        )
        .bind(
          Number(input.delivered),
          Number(input.delivered),
          now,
          now,
          input.delivered ? null : (input.errorCode ?? "queue_unavailable"),
          input.sequence,
          input.leaseToken,
          now,
        )
        .run();
      return { updated: result.meta.changes === 1 };
    }
    default:
      throw new BridgeError(404, "operation_not_found");
  }
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BridgeError(400, "invalid_request");
  return result.data;
}
