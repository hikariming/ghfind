import { z } from "zod";
import { BridgeError } from "./contract";
import { FeedStore } from "./store";
import { FeedArchive } from "./archive";

const id = z.string().min(1).max(160),
  integer = z.number().int().safe().positive();
const lease = { writerEpoch: integer, deletionId: id, leaseOwner: id };
export const cleanupSchemas = {
  pending: z.strictObject({}),
  claim: z.strictObject({
    writerEpoch: integer,
    leaseOwner: id,
    leaseSeconds: z.literal(90),
  }),
  step: z.strictObject(lease),
  release: z.strictObject(lease),
  fail: z.strictObject({
    ...lease,
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  }),
};
export type CleanupOperation = keyof typeof cleanupSchemas;
export type CleanupLease = z.infer<typeof cleanupSchemas.step>;
type Job = {
  deletion_id: string;
  github_id: number;
  profile_floor: number;
  requested_at: number;
  status: string;
  phase: string;
  primary_table: number;
  archive_cursor: string | null;
  archive_scan_done: number;
  failures: number;
  claims: number;
  lease_owner: string | null;
  lease_until: number | null;
};
export class FeedCleanup extends FeedStore {
  constructor(readonly environment: Env) {
    super(environment.FEED_DB);
  }
  async pending() {
    const now = Date.now();
    const [row] = await this.rows<{ pending: number }>(
      "SELECT (EXISTS(SELECT 1 FROM feed_runtime_control WHERE id=1 AND writes_enabled=1) AND (EXISTS(SELECT 1 FROM feed_cleanup_jobs WHERE status='pending' AND available_at<=? LIMIT 1) OR EXISTS(SELECT 1 FROM feed_cleanup_jobs WHERE status='leased' AND lease_until<=? LIMIT 1))) AS pending",
      now,
      now,
    );
    return { pending: row.pending === 1 };
  }
  guardLease(command: string, input: CleanupLease) {
    return this.sql(
      "INSERT INTO feed_execution_guards(id,writer_ok,identity_ok,lease_ok) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM feed_runtime_control WHERE id=1 AND writer_epoch=? AND writes_enabled=1) THEN 1 ELSE 0 END,1,CASE WHEN EXISTS(SELECT 1 FROM feed_cleanup_jobs WHERE deletion_id=? AND status='leased' AND lease_owner=? AND lease_until>?) THEN 1 ELSE 0 END)",
      command,
      input.writerEpoch,
      input.deletionId,
      input.leaseOwner,
      Date.now(),
    );
  }
  endLease(command: string) {
    return this.sql("DELETE FROM feed_execution_guards WHERE id=?", command);
  }
  async claim(input: z.infer<typeof cleanupSchemas.claim>) {
    const command = crypto.randomUUID(),
      now = Date.now();
    const results = await this.batch([
      this.guard(
        command,
        { writerEpoch: input.writerEpoch, expectedProfileVersion: 0 },
        0,
        { ensure: true },
      ),
      this.sql(
        "UPDATE feed_cleanup_jobs SET failures=failures+1,status=CASE WHEN failures>=7 THEN 'failed' ELSE 'pending' END,lease_owner=NULL,lease_until=NULL,last_error='lease_expired',transition_id=?,updated_at=? WHERE deletion_id IN(SELECT deletion_id FROM feed_cleanup_jobs WHERE status='leased' AND lease_until<=? ORDER BY lease_until LIMIT 100)",
        command,
        now,
        now,
      ),
      this.sql(
        "UPDATE feed_profile_deletions SET status='failed',last_error='lease_expired' WHERE id IN(SELECT deletion_id FROM feed_cleanup_jobs WHERE status='failed' AND transition_id=?)",
        command,
      ),
      this.sql(
        "UPDATE feed_cleanup_jobs SET status='leased',claims=claims+1,lease_owner=?,lease_until=?,updated_at=? WHERE deletion_id=(SELECT deletion_id FROM feed_cleanup_jobs WHERE status='pending' AND available_at<=? ORDER BY requested_at,deletion_id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM feed_cleanup_jobs WHERE status='leased' AND lease_owner=? AND lease_until>?)",
        input.leaseOwner,
        now + 90000,
        now,
        now,
        input.leaseOwner,
        now,
      ),
      this.sql(
        "SELECT * FROM feed_cleanup_jobs WHERE status='leased' AND lease_owner=? AND lease_until>? ORDER BY updated_at DESC LIMIT 1",
        input.leaseOwner,
        now,
      ),
      this.end(command),
    ]);
    const job = results[4].results[0] as Job | undefined;
    return job
      ? {
          status: "leased",
          deletionId: job.deletion_id,
          profileFloor: job.profile_floor,
          phase: job.phase,
          attempts: job.claims,
          failures: job.failures,
          leaseUntil: new Date(job.lease_until!).toISOString(),
        }
      : { status: "idle" };
  }
  async finish(input: CleanupLease, errorCode?: string) {
    const command = crypto.randomUUID(),
      now = Date.now();
    await this.batch([
      this.guardLease(command, input),
      errorCode
        ? this.sql(
            "UPDATE feed_cleanup_jobs SET failures=failures+1,status=CASE WHEN failures>=7 THEN 'failed' ELSE 'pending' END,available_at=?+MIN(300000,5000*(1<<MIN(failures,6))),lease_owner=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE deletion_id=?",
            now,
            errorCode,
            now,
            input.deletionId,
          )
        : this.sql(
            "UPDATE feed_cleanup_jobs SET status='pending',available_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE deletion_id=?",
            now,
            now,
            input.deletionId,
          ),
      this.sql(
        "UPDATE feed_profile_deletions SET status=CASE WHEN (SELECT status FROM feed_cleanup_jobs WHERE deletion_id=?)='failed' THEN 'failed' ELSE 'running' END,last_error=(SELECT last_error FROM feed_cleanup_jobs WHERE deletion_id=?) WHERE id=?",
        input.deletionId,
        input.deletionId,
        input.deletionId,
      ),
      this.endLease(command),
    ]);
    return { ok: true };
  }
  private async job(input: CleanupLease) {
    const command = crypto.randomUUID(),
      rows = await this.batch([
        this.guardLease(command, input),
        this.sql(
          "SELECT * FROM feed_cleanup_jobs WHERE deletion_id=?",
          input.deletionId,
        ),
        this.endLease(command),
      ]);
    return rows[1].results[0] as Job;
  }
  async step(input: CleanupLease) {
    const job = await this.job(input),
      command = crypto.randomUUID(),
      now = Date.now();
    if (job.phase === "primary") return this.primary(input, job);
    if (job.phase === "archive") {
      const archive = new FeedArchive(this.environment.FEED_ARCHIVE, this.db);
      const registered = await archive.eraseRegistered(
        job.github_id,
        job.profile_floor,
        job.requested_at,
      );
      if (registered) {
        await this.batch([
          this.guardLease(command, input),
          this.sql(
            "UPDATE feed_cleanup_jobs SET updated_at=? WHERE deletion_id=?",
            now,
            input.deletionId,
          ),
          this.endLease(command),
        ]);
        return { status: "running", phase: "archive", processed: registered };
      }
      const page = await archive.eraseLegacyPage(
        job.github_id,
        job.profile_floor,
        job.requested_at,
        job.archive_cursor ?? undefined,
      );
      await this.batch([
        this.guardLease(command, input),
        this.sql(
          "UPDATE feed_cleanup_jobs SET archive_cursor=?,archive_scan_done=?,phase=CASE WHEN ?=1 THEN 'semantic' ELSE 'archive' END,updated_at=? WHERE deletion_id=?",
          page.cursor ?? null,
          Number(page.complete),
          Number(page.complete),
          now,
          input.deletionId,
        ),
        this.sql(
          "UPDATE feed_profile_deletions SET archive_complete=? WHERE id=?",
          Number(page.complete),
          input.deletionId,
        ),
        this.endLease(command),
      ]);
      return {
        status: "running",
        phase: page.complete ? "semantic" : "archive",
        processed: page.processed,
      };
    }
    if (job.phase === "semantic") {
      const [policy] = await this.rows<{ semantic_mode: string }>(
        "SELECT semantic_mode FROM feed_cleanup_policy WHERE id=1",
      );
      if (
        policy?.semantic_mode !== "disabled" ||
        this.environment.FEED_SEMANTIC_STATE !== "disabled"
      )
        throw new BridgeError(503, "semantic_cleanup_unavailable");
      await this.batch([
        this.guardLease(command, input),
        this.sql(
          "UPDATE feed_profile_deletions SET semantic_complete=1,status='completed',completed_at=?,last_error=NULL WHERE id=? AND primary_complete=1 AND archive_complete=1 AND EXISTS(SELECT 1 FROM feed_cleanup_policy WHERE id=1 AND semantic_mode='disabled')",
          now,
          input.deletionId,
        ),
        this.sql(
          "UPDATE feed_cleanup_jobs SET status='completed',phase='completed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE deletion_id=? AND EXISTS(SELECT 1 FROM feed_profile_deletions WHERE id=? AND status='completed')",
          now,
          input.deletionId,
          input.deletionId,
        ),
        this.sql(
          "UPDATE feed_runtime_outbox SET status='completed',lease_until=NULL,last_error=NULL WHERE id=? AND EXISTS(SELECT 1 FROM feed_profile_deletions WHERE id=? AND status='completed')",
          input.deletionId,
          input.deletionId,
        ),
        this.endLease(command),
      ]);
      const [result] = await this.rows<{ status: string }>(
        "SELECT status FROM feed_profile_deletions WHERE id=?",
        input.deletionId,
      );
      if (result.status !== "completed")
        throw new BridgeError(409, "cleanup_checkpoint_changed");
      return { status: "completed", phase: "completed", processed: 0 };
    }
    throw new BridgeError(409, "cleanup_checkpoint_changed");
  }
  private async primary(input: CleanupLease, j: Job) {
    const command = crypto.randomUUID(),
      now = Date.now(),
      id = j.github_id,
      floor = j.profile_floor,
      at = j.requested_at;
    const statements = [
      this.sql(
        "UPDATE feed_user_tag_proposals SET label_zh='',label_en='Deleted proposal',evidence_json='[]' WHERE id IN(SELECT proposal_id FROM feed_user_proposal_authors WHERE github_id=? AND profile_version<=? AND redacted_at IS NULL ORDER BY proposal_id LIMIT 100)",
        id,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_events WHERE rowid IN(SELECT e.rowid FROM feed_events e WHERE github_id=? AND created_at<=? AND NOT EXISTS(SELECT 1 FROM feed_runtime_requests r WHERE r.id=e.request_id AND r.profile_version>?) LIMIT 100)",
        id,
        at,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_runtime_events WHERE rowid IN(SELECT rowid FROM feed_runtime_events WHERE github_id=? AND profile_version<=? LIMIT 100)",
        id,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_runtime_served_metadata WHERE rowid IN(SELECT m.rowid FROM feed_runtime_served_metadata m JOIN feed_served_items s ON s.request_id=m.request_id AND s.repo_key=m.repo_key WHERE s.github_id=? AND s.served_at<=? AND NOT EXISTS(SELECT 1 FROM feed_runtime_requests r WHERE r.id=s.request_id AND r.profile_version>?) LIMIT 100)",
        id,
        at,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_served_items WHERE rowid IN(SELECT s.rowid FROM feed_served_items s WHERE github_id=? AND served_at<=? AND NOT EXISTS(SELECT 1 FROM feed_runtime_requests r WHERE r.id=s.request_id AND r.profile_version>?) LIMIT 100)",
        id,
        at,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_runtime_requests WHERE rowid IN(SELECT rowid FROM feed_runtime_requests WHERE github_id=? AND profile_version<=? LIMIT 100)",
        id,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_runtime_outbox WHERE rowid IN(SELECT rowid FROM feed_runtime_outbox WHERE aggregate_key=? AND profile_version<=? AND topic<>'feed.user-delete.v1' LIMIT 100)",
        `gh:${id}`,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_tag_proposal_commands WHERE rowid IN(SELECT rowid FROM feed_tag_proposal_commands WHERE github_id=? AND profile_version<=? LIMIT 100)",
        id,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_user_proposal_authors WHERE rowid IN(SELECT rowid FROM feed_user_proposal_authors WHERE github_id=? AND profile_version<=? LIMIT 100)",
        id,
        floor,
      ),
    ];
    if (j.primary_table >= statements.length)
      throw new BridgeError(409, "cleanup_checkpoint_changed");
    const result = await this.batch([
      this.guardLease(command, input),
      statements[j.primary_table],
      this.sql(
        "UPDATE feed_cleanup_jobs SET primary_table=primary_table+CASE WHEN changes()<100 THEN 1 ELSE 0 END,updated_at=? WHERE deletion_id=?",
        now,
        input.deletionId,
      ),
      ...(j.primary_table === 0
        ? [
            this.sql(
              "UPDATE feed_user_proposal_authors SET redacted_at=? WHERE proposal_id IN(SELECT proposal_id FROM feed_user_proposal_authors WHERE github_id=? AND profile_version<=? AND redacted_at IS NULL ORDER BY proposal_id LIMIT 100)",
              now,
              id,
              floor,
            ),
          ]
        : []),
      this.sql(
        "UPDATE feed_profile_deletions SET status='running',primary_complete=CASE WHEN (SELECT primary_table FROM feed_cleanup_jobs WHERE deletion_id=?)>=? THEN 1 ELSE 0 END WHERE id=?",
        input.deletionId,
        statements.length,
        input.deletionId,
      ),
      this.sql(
        "UPDATE feed_cleanup_jobs SET phase=CASE WHEN primary_table>=? THEN 'archive' ELSE 'primary' END WHERE deletion_id=?",
        statements.length,
        input.deletionId,
      ),
      this.endLease(command),
    ]);
    return {
      status: "running",
      phase:
        j.primary_table === statements.length - 1 &&
        result[1].meta.changes < 100
          ? "archive"
          : "primary",
      processed: result[1].meta.changes,
    };
  }
}
