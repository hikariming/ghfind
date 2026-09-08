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
    return { job: rows[0] ?? null };
  }
  async replay(input: z.infer<typeof operatorSchemas.replay>) {
    const command = crypto.randomUUID(),
      now = Date.now();
    const eligible =
      input.kind === "sourceEvent"
        ? "EXISTS(SELECT 1 FROM feed_execution_jobs WHERE event_id=? AND status='dead_letter')"
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
        : []),
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
