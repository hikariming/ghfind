import { z } from "zod";
import { BridgeError } from "./contract";
import { sourceReplayStatements } from "../../shared/feed-source-statements";

const target = {
  kind: z.literal("coreSource"),
  id: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .refine((value) => Number.isSafeInteger(Number(value))),
};
export const coreSourceOperatorSchemas = {
  status: z.strictObject(target),
  replay: z.strictObject({
    ...target,
    commandId: z
      .uuid()
      .refine((value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value,
        ),
      ),
    operator: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => value.trim().length > 0),
    reason: z
      .string()
      .min(8)
      .max(500)
      .refine((value) => [...value.trim()].length >= 8),
  }),
};

// This capability owns only the core DB. A Feed migration epoch cannot fence
// source delivery, and a preflight against another DB would not be atomic.
export class CoreSourceOperator {
  constructor(readonly db: D1Database) {}
  async status(input: z.infer<typeof coreSourceOperatorSchemas.status>) {
    const job = await this.db
      .prepare(
        `SELECT CAST(sequence AS TEXT) AS id,'coreSource' AS sourceKind,sequence,status,attempts,
      available_at AS availableAt,lease_expires_at AS leaseUntil,last_error AS lastError,
      replay_count AS replayCount,replayed_at AS replayedAt FROM feed_source_outbox WHERE sequence=?`,
      )
      .bind(Number(input.id))
      .first();
    return { job };
  }
  async replay(input: z.infer<typeof coreSourceOperatorSchemas.replay>) {
    try {
      const statements = sourceReplayStatements({
        sequence: Number(input.id),
        commandId: input.commandId,
        operator: input.operator,
        reason: input.reason,
        now: Date.now(),
      });
      await this.db.batch(
        statements.map((statement) =>
          this.db.prepare(statement.sql).bind(...statement.args),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      for (const code of [
        "source_replay_conflict",
        "source_replay_not_allowed",
      ]) {
        if (message.includes(code)) throw new BridgeError(409, code);
      }
      throw error;
    }
    // Stable acceptance receipt, even if the original command's source message
    // is already leased/delivered. Repeating it never restarts delivery again.
    return { ok: true };
  }
}
