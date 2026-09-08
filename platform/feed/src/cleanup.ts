import { z } from "zod";
import { BridgeError, hash } from "./contract";
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
    if (j.primary_table === 0) return this.redactProposals(input, j);
    const command = crypto.randomUUID(),
      now = Date.now(),
      id = j.github_id,
      floor = j.profile_floor,
      at = j.requested_at;
    const statements = [
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
        "UPDATE feed_tag_proposal_commands SET proposal_id='',payload_hash='deleted',created_at=0 WHERE rowid IN(SELECT rowid FROM feed_tag_proposal_commands WHERE github_id=? AND profile_version<=? AND (proposal_id<>'' OR payload_hash<>'deleted' OR created_at<>0) LIMIT 100)",
        id,
        floor,
      ),
      this.sql(
        "DELETE FROM feed_user_proposal_authors WHERE rowid IN(SELECT rowid FROM feed_user_proposal_authors WHERE github_id=? AND profile_version<=? LIMIT 100)",
        id,
        floor,
      ),
    ];
    if (j.primary_table > statements.length)
      throw new BridgeError(409, "cleanup_checkpoint_changed");
    const result = await this.batch([
      this.guardLease(command, input),
      statements[j.primary_table - 1],
      this.sql(
        "UPDATE feed_cleanup_jobs SET primary_table=primary_table+CASE WHEN changes()<100 THEN 1 ELSE 0 END,updated_at=? WHERE deletion_id=?",
        now,
        input.deletionId,
      ),
      this.sql(
        "UPDATE feed_profile_deletions SET status='running',primary_complete=CASE WHEN (SELECT primary_table FROM feed_cleanup_jobs WHERE deletion_id=?)>=? THEN 1 ELSE 0 END WHERE id=?",
        input.deletionId,
        statements.length + 1,
        input.deletionId,
      ),
      this.sql(
        "UPDATE feed_cleanup_jobs SET phase=CASE WHEN primary_table>=? THEN 'archive' ELSE 'primary' END WHERE deletion_id=?",
        statements.length + 1,
        input.deletionId,
      ),
      this.endLease(command),
    ]);
    return {
      status: "running",
      phase:
        j.primary_table === statements.length && result[1].meta.changes < 100
          ? "archive"
          : "primary",
      processed: result[1].meta.changes,
    };
  }

  private async redactProposals(input: CleanupLease, j: Job) {
    // Twenty bodies bound both hash work and conditional-write parameter bytes.
    // The author checkpoint is advanced only after every attributed copy clears.
    const authors = await this.rows<{ proposal_id: string }>(
      "SELECT proposal_id FROM feed_user_proposal_authors WHERE github_id=? AND profile_version<=? AND redacted_at IS NULL ORDER BY proposal_id LIMIT 20",
      j.github_id,
      j.profile_floor,
    );
    const ids = JSON.stringify(authors.map((a) => a.proposal_id));
    const legacy = await this.rows<{
      proposal_id: string;
      repo_key: string;
      tag_id: string;
      analysis_id: string;
      taxonomy_version: number;
      weight: number;
      confidence: number;
      updated_at: number;
      evidence_json: string;
      evidence_hash: string;
    }>(
      `SELECT c.proposal_id,p.repo_key,p.tag_id,p.analysis_id,p.taxonomy_version,p.weight,p.confidence,p.updated_at,p.evidence_json,c.evidence_hash
       FROM feed_governance_commands c JOIN feed_project_tags p ON p.repo_key=c.repo_key AND p.tag_id=c.canonical_tag_id
       AND p.source='admin' AND p.origin_proposal_id IS NULL AND p.analysis_id=c.analysis_id AND p.taxonomy_version=c.taxonomy_version
       AND p.weight=c.assignment_weight AND p.confidence=c.assignment_confidence AND p.updated_at=c.created_at
       WHERE c.proposal_kind='user' AND c.action IN ('create','map') AND c.proposal_id IN(SELECT value FROM json_each(?)) LIMIT 21`,
      ids,
    );
    if (
      legacy.length > 20 ||
      legacy.some(
        (p) => new TextEncoder().encode(p.evidence_json).length > 32768,
      )
    )
      throw new BridgeError(409, "cleanup_legacy_evidence_unresolved");
    const proofs = [];
    for (const row of legacy)
      if ((await hash(row.evidence_json)) === row.evidence_hash)
        proofs.push(row);
    const encoded = JSON.stringify(proofs),
      command = crypto.randomUUID(),
      now = Date.now();
    // Matching hash is necessary but not sufficient: the same transaction pins
    // all current assignment fields so a later review/projection is untouched.
    const match = `p.origin_proposal_id IS NULL AND p.source='admin' AND p.repo_key=json_extract(v.value,'$.repo_key') AND p.tag_id=json_extract(v.value,'$.tag_id')
      AND p.analysis_id=json_extract(v.value,'$.analysis_id') AND p.taxonomy_version=json_extract(v.value,'$.taxonomy_version')
      AND p.weight=json_extract(v.value,'$.weight') AND p.confidence=json_extract(v.value,'$.confidence')
      AND p.updated_at=json_extract(v.value,'$.updated_at') AND p.evidence_json=json_extract(v.value,'$.evidence_json')`;
    await this.batch([
      this.guardLease(command, input),
      this.sql(
        `UPDATE feed_project_tags AS p SET origin_proposal_id=(SELECT json_extract(v.value,'$.proposal_id') FROM json_each(?) v WHERE ${match})
         WHERE EXISTS(SELECT 1 FROM json_each(?) v WHERE ${match})`,
        encoded,
        encoded,
      ),
      this.sql(
        "UPDATE feed_project_tags SET evidence_json='[]' WHERE origin_proposal_id IN(SELECT value FROM json_each(?))",
        ids,
      ),
      this.sql(
        "UPDATE feed_user_tag_proposals SET slug='deleted-proposal',label_zh='',label_en='Deleted proposal',evidence_json='[]' WHERE id IN(SELECT value FROM json_each(?))",
        ids,
      ),
      this.sql(
        "UPDATE feed_user_proposal_authors SET redacted_at=? WHERE proposal_id IN(SELECT value FROM json_each(?)) AND github_id=? AND profile_version<=?",
        now,
        ids,
        j.github_id,
        j.profile_floor,
      ),
      this.sql(
        "UPDATE feed_cleanup_jobs SET primary_table=CASE WHEN ?<20 THEN 1 ELSE 0 END,updated_at=? WHERE deletion_id=?",
        authors.length,
        now,
        input.deletionId,
      ),
      this.endLease(command),
    ]);
    return { status: "running", phase: "primary", processed: authors.length };
  }
}
