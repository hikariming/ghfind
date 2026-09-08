import { z } from "zod";
import { FeedStore } from "./store";

const target = {
  kind: z.enum(["sourceEvent", "deletion"]),
  id: z.string().min(1).max(160),
};
export const operatorSchemas = {
  status: z.strictObject(target),
  replay: z.strictObject({
    ...target,
    writerEpoch: z.number().int().safe().positive(),
    commandId: z.uuid(),
    operator: z.string().min(1).max(100),
    reason: z.string().min(8).max(500),
  }),
};
export class FeedOperator extends FeedStore {
  async status(input: z.infer<typeof operatorSchemas.status>) {
    const rows =
      input.kind === "sourceEvent"
        ? await this.rows(
            "SELECT event_id AS id,status,attempts,available_at AS availableAt,lease_until AS leaseUntil,last_error AS lastError FROM feed_execution_jobs WHERE event_id=?",
            input.id,
          )
        : await this.rows(
            "SELECT deletion_id AS id,status,phase,failures,claims,primary_table AS primaryTable,archive_scan_done AS archiveScanDone,available_at AS availableAt,lease_until AS leaseUntil,last_error AS lastError FROM feed_cleanup_jobs WHERE deletion_id=?",
            input.id,
          );
    if (input.kind !== "sourceEvent") return { job: rows[0] ?? null };
    const [deliveries, terminals] = await Promise.all([
      this.rows(
        `SELECT d.delivery_id AS deliveryId,d.status,d.attempts,d.available_at AS availableAt,
        d.lease_until AS leaseUntil,d.last_error AS lastError,d.published_at AS publishedAt
        FROM feed_replay_deliveries d JOIN feed_delivery_heads h ON h.delivery_id=d.delivery_id AND h.event_id=d.event_id WHERE h.event_id=?`,
        input.id,
      ),
      this.rows(
        `SELECT t.delivery_id AS deliveryId,t.message_id AS messageId,t.queue,t.attempts,t.received_at AS receivedAt,
        CASE WHEN h.delivery_id=t.delivery_id THEN 1 ELSE 0 END AS isCurrent
        FROM feed_delivery_terminals t JOIN feed_delivery_heads h ON h.event_id=t.event_id
        WHERE t.event_id=? ORDER BY t.received_at DESC,t.message_id LIMIT 1`,
        input.id,
      ),
    ]);
    return {
      job: rows[0] ?? null,
      delivery: deliveries[0] ?? null,
      terminalEvidence: terminals[0]
        ? { ...terminals[0], isCurrent: terminals[0].isCurrent === 1 }
        : null,
    };
  }
  async replay(input: z.infer<typeof operatorSchemas.replay>) {
    const command = crypto.randomUUID(),
      now = Date.now();
    const eligible =
      input.kind === "sourceEvent"
        ? `EXISTS(SELECT 1 FROM feed_execution_jobs j WHERE j.event_id=? AND
          (j.status='dead_letter' OR ((j.status='pending' OR (j.status='leased' AND j.lease_until<=${now})) AND
            (EXISTS(SELECT 1 FROM feed_delivery_terminals t JOIN feed_delivery_heads h ON h.event_id=t.event_id AND h.delivery_id=t.delivery_id WHERE t.event_id=j.event_id)
              OR EXISTS(SELECT 1 FROM feed_replay_deliveries d JOIN feed_delivery_heads h ON h.delivery_id=d.delivery_id AND h.event_id=d.event_id WHERE d.event_id=j.event_id AND d.status='failed')))))`
        : "EXISTS(SELECT 1 FROM feed_cleanup_jobs WHERE deletion_id=? AND status='failed')";
    await this.batch([
      this.guard(
        command,
        { writerEpoch: input.writerEpoch, expectedProfileVersion: 0 },
        0,
        {
          ensure: true,
          payload:
            "CASE WHEN NOT EXISTS(SELECT 1 FROM feed_operator_actions WHERE id=? AND (kind<>? OR target_id<>? OR operator<>? OR reason<>?)) THEN 1 ELSE 0 END",
          payloadValues: [
            input.commandId,
            input.kind,
            input.id,
            input.operator,
            input.reason,
          ],
        },
      ),
      this.sql(
        `INSERT INTO feed_operator_guards(id,valid) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM feed_operator_actions WHERE id=?) OR ${eligible} THEN 1 ELSE 0 END)`,
        command,
        input.commandId,
        input.id,
      ),
      input.kind === "sourceEvent"
        ? this.sql(
            "UPDATE feed_execution_jobs SET status='pending',attempts=0,available_at=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE event_id=? AND NOT EXISTS(SELECT 1 FROM feed_operator_actions WHERE id=?)",
            now,
            now,
            input.id,
            input.commandId,
          )
        : this.sql(
            "UPDATE feed_cleanup_jobs SET status='pending',failures=0,available_at=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE deletion_id=? AND NOT EXISTS(SELECT 1 FROM feed_operator_actions WHERE id=?)",
            now,
            now,
            input.id,
            input.commandId,
          ),
      ...(input.kind === "deletion"
        ? [
            this.sql(
              "UPDATE feed_profile_deletions SET status='pending',last_error=NULL WHERE id=? AND EXISTS(SELECT 1 FROM feed_cleanup_jobs WHERE deletion_id=? AND status='pending')",
              input.id,
              input.id,
            ),
          ]
        : [
            this.sql(
              `UPDATE feed_replay_deliveries SET status='superseded',lease_owner=NULL,lease_until=NULL,updated_at=?
              WHERE event_id=? AND status IN ('pending','leased') AND NOT EXISTS(SELECT 1 FROM feed_operator_actions WHERE id=?)`,
              now,
              input.id,
              input.commandId,
            ),
            this.sql(
              `INSERT INTO feed_delivery_heads(event_id,delivery_id,updated_at)
              SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM feed_operator_actions WHERE id=?)
              ON CONFLICT(event_id) DO UPDATE SET delivery_id=excluded.delivery_id,updated_at=excluded.updated_at`,
              input.id,
              input.commandId,
              now,
              input.commandId,
            ),
            this.sql(
              `INSERT INTO feed_replay_deliveries(delivery_id,event_id,status,available_at,created_at,updated_at)
              VALUES(?,?,'pending',?,?,?) ON CONFLICT(delivery_id) DO NOTHING`,
              input.commandId,
              input.id,
              now,
              now,
              now,
            ),
          ]),
      this.sql(
        "INSERT INTO feed_operator_actions(id,kind,target_id,operator,reason,action,created_at) VALUES(?,?,?,?,?,'replay',?) ON CONFLICT(id) DO NOTHING",
        input.commandId,
        input.kind,
        input.id,
        input.operator,
        input.reason,
        now,
      ),
      this.sql("DELETE FROM feed_operator_guards WHERE id=?", command),
      this.end(command),
    ]);
    return { ok: true };
  }
}
