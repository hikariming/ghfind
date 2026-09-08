import { z } from "zod";
import { hash } from "./contract";
import { sourceEvent } from "./executor-contract";
import { FeedJobs } from "./jobs";

const integer = z.number().int().safe();
const id = z.string().min(1).max(160);
const deliveryId = z.union([
  z.uuid(),
  z.string().regex(/^source:[1-9][0-9]{0,15}$/),
]);
export const deliverySchemas = {
  pending: z.strictObject({}),
  claim: z.strictObject({
    writerEpoch: integer.positive(),
    leaseOwner: id,
    limit: integer.min(1).max(20),
    leaseSeconds: z.literal(60),
  }),
  finish: z.strictObject({
    writerEpoch: integer.positive(),
    deliveryId,
    leaseOwner: id,
    delivered: z.boolean(),
    errorCode: z.enum(["queue_unavailable", "invalid_event"]).optional(),
  }),
  terminal: z.strictObject({
    writerEpoch: integer.positive(),
    deliveryId,
    event: sourceEvent,
    messageId: id,
    queue: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    attempts: integer.min(1).max(1000),
  }),
};

const runnable = `EXISTS(SELECT 1 FROM feed_delivery_heads h JOIN feed_execution_jobs j ON j.event_id=h.event_id
  WHERE h.event_id=feed_replay_deliveries.event_id AND h.delivery_id=feed_replay_deliveries.delivery_id AND j.status<>'completed')`;

export class FeedDelivery extends FeedJobs {
  async pending() {
    const [row] = await this.rows<{ pending: number }>(
      `SELECT CASE WHEN EXISTS(SELECT 1 FROM feed_runtime_control WHERE id=1 AND writes_enabled=1)
        AND (EXISTS(SELECT 1 FROM feed_replay_deliveries WHERE status='pending' AND available_at<=? AND ${runnable})
          OR EXISTS(SELECT 1 FROM feed_replay_deliveries WHERE status='leased' AND lease_until<=? AND ${runnable}))
        THEN 1 ELSE 0 END AS pending`,
      Date.now(),
      Date.now(),
    );
    return { pending: row.pending === 1 };
  }
  async claimDelivery(input: z.infer<typeof deliverySchemas.claim>) {
    const command = crypto.randomUUID(),
      now = Date.now();
    const results = await this.batch([
      this.executionGuard(command, input.writerEpoch, "1", []),
      this.sql(
        `UPDATE feed_replay_deliveries SET status='failed',last_error='delivery_attempts_exhausted',lease_owner=NULL,lease_until=NULL,updated_at=?
        WHERE delivery_id IN (SELECT delivery_id FROM feed_replay_deliveries WHERE status='leased' AND lease_until<=? AND attempts>=8 ORDER BY lease_until LIMIT 100)`,
        now,
        now,
      ),
      this.sql(
        `UPDATE feed_replay_deliveries SET status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=?
        WHERE delivery_id IN (SELECT d.delivery_id FROM feed_replay_deliveries d JOIN feed_execution_jobs j ON j.event_id=d.event_id
          WHERE d.status IN ('pending','leased') AND j.status='completed' ORDER BY d.created_at LIMIT 100)`,
        now,
      ),
      this.sql(
        `UPDATE feed_replay_deliveries SET status='leased',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=?
        WHERE delivery_id IN (SELECT delivery_id FROM feed_replay_deliveries WHERE attempts<8 AND
          ((status='pending' AND available_at<=?) OR (status='leased' AND lease_until<=?)) AND ${runnable}
          ORDER BY available_at,delivery_id LIMIT ?) RETURNING delivery_id,event_id,attempts`,
        input.leaseOwner,
        now + 60000,
        now,
        now,
        now,
        input.limit,
      ),
      this.sql(
        `SELECT d.delivery_id,j.envelope_json,d.attempts FROM feed_replay_deliveries d JOIN feed_execution_jobs j ON j.event_id=d.event_id
        WHERE d.status='leased' AND d.lease_owner=? AND d.lease_until=? ORDER BY d.available_at,d.delivery_id LIMIT 20`,
        input.leaseOwner,
        now + 60000,
      ),
      this.executionEnd(command),
    ]);
    return {
      deliveries: (
        results[4].results as {
          delivery_id: string;
          envelope_json: string;
          attempts: number;
        }[]
      ).map((row) => ({
        deliveryId: row.delivery_id,
        event: sourceEvent.parse(JSON.parse(row.envelope_json)),
        leaseOwner: input.leaseOwner,
        attempts: row.attempts,
      })),
    };
  }
  async finishDelivery(input: z.infer<typeof deliverySchemas.finish>) {
    const command = crypto.randomUUID(),
      now = Date.now();
    const results = await this.batch([
      this.executionGuard(command, input.writerEpoch, "1", []),
      this.sql(
        `UPDATE feed_replay_deliveries SET status=CASE WHEN ?=1 THEN 'published' WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,
        available_at=?+MIN(300000,5000*(1<<MIN(attempts-1,6))),lease_owner=NULL,lease_until=NULL,
        last_error=?,published_at=CASE WHEN ?=1 THEN ? ELSE NULL END,updated_at=?
        WHERE delivery_id=? AND status='leased' AND lease_owner=? AND lease_until>? AND ${runnable}`,
        Number(input.delivered),
        now,
        input.delivered ? null : (input.errorCode ?? "queue_unavailable"),
        Number(input.delivered),
        now,
        now,
        input.deliveryId,
        input.leaseOwner,
        now,
      ),
      this.executionEnd(command),
    ]);
    return { updated: results[1].meta.changes === 1 };
  }
  async terminal(input: z.infer<typeof deliverySchemas.terminal>) {
    const command = crypto.randomUUID(),
      now = Date.now(),
      encoded = JSON.stringify(input.event),
      digest = await hash(encoded);
    const results = await this.batch([
      this.executionGuard(
        command,
        input.writerEpoch,
        "CASE WHEN NOT EXISTS(SELECT 1 FROM feed_execution_jobs WHERE event_id=? AND envelope_hash<>?) THEN 1 ELSE 0 END",
        [input.event.eventId, digest],
      ),
      this.sql(
        `INSERT INTO feed_delivery_guards(id,valid) VALUES(?,CASE WHEN
        NOT EXISTS(SELECT 1 FROM feed_delivery_terminals WHERE queue=? AND message_id=? AND (event_id<>? OR delivery_id<>? OR envelope_hash<>?))
        AND NOT EXISTS(SELECT 1 FROM feed_execution_jobs WHERE source_version=? AND (event_id<>? OR envelope_hash<>?))
        AND (?=? OR EXISTS(SELECT 1 FROM feed_replay_deliveries WHERE delivery_id=? AND event_id=?)) THEN 1 ELSE 0 END)`,
        command,
        input.queue,
        input.messageId,
        input.event.eventId,
        input.deliveryId,
        digest,
        input.event.sourceVersion,
        input.event.eventId,
        digest,
        input.deliveryId,
        `source:${input.event.sourceVersion}`,
        input.deliveryId,
        input.event.eventId,
      ),
      this.sql(
        `INSERT INTO feed_execution_jobs(event_id,envelope_json,envelope_hash,aggregate_key,source_version,status,available_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',?,?,?) ON CONFLICT(event_id) DO NOTHING`,
        input.event.eventId,
        encoded,
        digest,
        input.event.aggregateKey,
        input.event.sourceVersion,
        now,
        now,
        now,
      ),
      this.sql(
        `INSERT INTO feed_delivery_heads(event_id,delivery_id,updated_at) VALUES(?,?,?) ON CONFLICT(event_id) DO NOTHING`,
        input.event.eventId,
        `source:${input.event.sourceVersion}`,
        now,
      ),
      this.sql(
        `INSERT INTO feed_delivery_terminals(queue,message_id,delivery_id,event_id,envelope_hash,attempts,received_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(queue,message_id) DO NOTHING`,
        input.queue,
        input.messageId,
        input.deliveryId,
        input.event.eventId,
        digest,
        input.attempts,
        now,
      ),
      this.sql(
        `UPDATE feed_execution_jobs SET status='dead_letter',lease_owner=NULL,lease_until=NULL,last_error='queue_delivery_exhausted',updated_at=?
        WHERE event_id=? AND (status='pending' OR (status='leased' AND lease_until<=?))
        AND EXISTS(SELECT 1 FROM feed_delivery_heads WHERE event_id=? AND delivery_id=?)`,
        now,
        input.event.eventId,
        now,
        input.event.eventId,
        input.deliveryId,
      ),
      this.sql(
        `SELECT CASE WHEN EXISTS(SELECT 1 FROM feed_delivery_heads WHERE event_id=? AND delivery_id=?) THEN 1 ELSE 0 END AS current`,
        input.event.eventId,
        input.deliveryId,
      ),
      this.sql("DELETE FROM feed_delivery_guards WHERE id=?", command),
      this.executionEnd(command),
    ]);
    return {
      ok: true,
      current: (results[6].results[0] as { current: number }).current === 1,
    };
  }
}
