import { BridgeError, hash } from "./contract";
import type { ExecutorInput } from "./executor-contract";
import { FeedStore } from "./store";

export class FeedJobs extends FeedStore {
  executionGuard(
    command: string,
    epoch: number,
    identity: string,
    identityValues: (string | number)[],
    lease = "1",
    leaseValues: (string | number)[] = [],
  ) {
    return this.sql(
      `INSERT INTO feed_execution_guards(id,writer_ok,identity_ok,lease_ok) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM feed_runtime_control WHERE id=1 AND writer_epoch=? AND writes_enabled=1) THEN 1 ELSE 0 END,${identity},${lease})`,
      command,
      epoch,
      ...identityValues,
      ...leaseValues,
    );
  }
  executionEnd(command: string) {
    return this.sql("DELETE FROM feed_execution_guards WHERE id=?", command);
  }
  leasePredicate() {
    return "CASE WHEN EXISTS(SELECT 1 FROM feed_execution_jobs WHERE event_id=? AND status='leased' AND lease_owner=? AND lease_until>?) THEN 1 ELSE 0 END";
  }
  async claim(input: ExecutorInput<"jobs.claim">) {
    const command = crypto.randomUUID(),
      now = Date.now(),
      encoded = JSON.stringify(input.event),
      digest = await hash(encoded);
    const result = await this.batch([
      this.executionGuard(
        command,
        input.writerEpoch,
        "CASE WHEN NOT EXISTS(SELECT 1 FROM feed_execution_jobs WHERE event_id=? AND envelope_hash<>?) THEN 1 ELSE 0 END",
        [input.event.eventId, digest],
      ),
      this.sql(
        "INSERT INTO feed_execution_jobs(event_id,envelope_json,envelope_hash,aggregate_key,source_version,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?) ON CONFLICT(event_id) DO NOTHING",
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
        "UPDATE feed_execution_jobs SET status='dead_letter',last_error='lease_attempts_exhausted',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE event_id=? AND attempts>=8 AND status<>'completed' AND (status<>'leased' OR lease_until<=?)",
        now,
        input.event.eventId,
        now,
      ),
      this.sql(
        `UPDATE feed_execution_jobs SET status='leased',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=?
        WHERE event_id=? AND attempts<8 AND ((status='pending' AND available_at<=?) OR (status='leased' AND lease_until<=?))`,
        input.leaseOwner,
        now + 90000,
        now,
        input.event.eventId,
        now,
        now,
      ),
      this.sql(
        "SELECT status,attempts,lease_owner,lease_until FROM feed_execution_jobs WHERE event_id=?",
        input.event.eventId,
      ),
      this.executionEnd(command),
    ]);
    const row = result[4].results[0] as {
      status: string;
      attempts: number;
      lease_owner: string | null;
      lease_until: number | null;
    };
    return {
      status:
        row.status === "leased" && row.lease_owner === input.leaseOwner
          ? "leased"
          : row.status === "completed" || row.status === "dead_letter"
            ? row.status
            : "busy",
      attempts: row.attempts,
      ...(row.lease_until
        ? { leaseUntil: new Date(row.lease_until).toISOString() }
        : {}),
    };
  }
  async finish(input: ExecutorInput<"jobs.complete">, failed: boolean) {
    if (failed && !input.errorCode)
      throw new BridgeError(400, "invalid_request");
    const command = crypto.randomUUID(),
      now = Date.now();
    await this.batch([
      this.executionGuard(
        command,
        input.writerEpoch,
        "1",
        [],
        this.leasePredicate(),
        [input.eventId, input.leaseOwner, now],
      ),
      failed
        ? this.sql(
            `UPDATE feed_execution_jobs SET status=CASE WHEN attempts>=8 THEN 'dead_letter' ELSE 'pending' END,
        available_at=?+MIN(300000,5000*(1<<MIN(attempts-1,6))),lease_owner=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE event_id=?`,
            now,
            input.errorCode!,
            now,
            input.eventId,
          )
        : this.sql(
            "UPDATE feed_execution_jobs SET status='completed',completed_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL,last_error=NULL WHERE event_id=?",
            now,
            now,
            input.eventId,
          ),
      this.executionEnd(command),
    ]);
    return { ok: true };
  }
  async apply(input: ExecutorInput<"projection.apply">) {
    const command = crypto.randomUUID(),
      now = Date.now(),
      p = input.projection,
      r = input.receipt;
    const tags = await Promise.all(
      [
        {
          namespace: "artifact",
          slug: p.projectType,
          labels: { zh: p.projectType, en: p.projectType },
          evidenceIds: [],
          namespaceExplicit: true,
          source: "derived",
          weight: 1,
        },
        {
          namespace: "stage",
          slug: p.lifecycle,
          labels: { zh: p.lifecycle, en: p.lifecycle },
          evidenceIds: [],
          namespaceExplicit: true,
          source: "derived",
          weight: 0.7,
        },
        ...p.productTags.map((t) => ({
          ...t,
          source: "assessment",
          weight: 0.9,
        })),
      ].map(async (t) => {
        const namespace = t.namespaceExplicit ? t.namespace : "use_case",
          slug = t.slug.trim().toLowerCase();
        if (
          ![
            "domain",
            "use_case",
            "audience",
            "artifact",
            "stack",
            "stage",
          ].includes(namespace)
        )
          throw new BridgeError(400, "invalid_request");
        return {
          ...t,
          namespace,
          slug,
          allowCanonical: Number(t.namespaceExplicit),
          confidence: Math.min(1, p.confidence / 100),
          proposalId: `proposal_${await hash(JSON.stringify([p.repoKey, p.analysisId, namespace, slug]))}`,
        };
      }),
    );
    const encodedTags = JSON.stringify(tags);
    const resolve = `WITH inputs AS (SELECT json_extract(value,'$.namespace') AS namespace,json_extract(value,'$.slug') AS slug,json_extract(value,'$.allowCanonical') AS allowed,json_extract(value,'$.source') AS source,json_extract(value,'$.weight') AS weight,json_extract(value,'$.confidence') AS confidence,json_extract(value,'$.evidenceIds') AS evidence,json_extract(value,'$.labels.zh') AS zh,json_extract(value,'$.labels.en') AS en,json_extract(value,'$.proposalId') AS proposal_id FROM json_each(?)),
      resolved AS (SELECT i.*,COALESCE(d.id,ad.id) AS tag_id FROM inputs i
        LEFT JOIN feed_tag_definitions d ON i.allowed=1 AND d.namespace=i.namespace AND d.slug=i.slug AND d.status='canonical'
        LEFT JOIN feed_tag_aliases a ON i.allowed=1 AND a.namespace=i.namespace AND a.slug=i.slug
        LEFT JOIN feed_tag_definitions ad ON ad.id=a.canonical_tag_id AND ad.status='canonical')`;
    const result = await this.batch([
      this.executionGuard(
        command,
        input.writerEpoch,
        `CASE WHEN EXISTS(SELECT 1 FROM feed_execution_jobs WHERE event_id=? AND aggregate_key=? AND source_version=? AND json_extract(envelope_json,'$.analysisId')=? AND json_extract(envelope_json,'$.receiptId')=?) THEN 1 ELSE 0 END`,
        [
          input.eventId,
          p.repoKey,
          input.sourceVersion,
          p.analysisId,
          r.receiptId,
        ],
        this.leasePredicate(),
        [input.eventId, input.leaseOwner, now],
      ),
      this.sql(
        `INSERT INTO feed_projection_commands(id,applied) VALUES(?,CASE WHEN MAX(COALESCE((SELECT source_version FROM feed_project_source_versions WHERE repo_key=?),0),COALESCE((SELECT source_version FROM feed_submission_provenance WHERE repo_key=?),0))<? THEN 1 ELSE 0 END)`,
        command,
        p.repoKey,
        p.repoKey,
        input.sourceVersion,
      ),
      this.sql(
        `INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,language,topics_json,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,treasure_eligible,classic_eligible,analyzed_at,risks_json,published,source_hash,projected_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN COALESCE((SELECT removed FROM feed_project_moderation WHERE repo_key=?),0)=1 THEN 0 WHEN ?=1 OR (?=1 AND COALESCE((SELECT allow_high_risk FROM feed_project_moderation WHERE repo_key=?),0)=1) THEN 1 ELSE 0 END,?,? FROM feed_projection_commands WHERE id=? AND applied=1
        ON CONFLICT(repo_key) DO UPDATE SET analysis_id=excluded.analysis_id,owner_login=excluded.owner_login,name=excluded.name,canonical_url=excluded.canonical_url,summary=excluded.summary,language=excluded.language,topics_json=excluded.topics_json,project_type=excluded.project_type,lifecycle=excluded.lifecycle,product_score=excluded.product_score,confidence=excluded.confidence,verification_level=excluded.verification_level,exposure_band=excluded.exposure_band,treasure_eligible=excluded.treasure_eligible,classic_eligible=excluded.classic_eligible,analyzed_at=excluded.analyzed_at,risks_json=excluded.risks_json,published=excluded.published,source_hash=excluded.source_hash,projected_at=excluded.projected_at`,
        p.repoKey,
        p.analysisId,
        p.ownerLogin,
        p.name,
        p.canonicalUrl,
        p.summary,
        p.language,
        JSON.stringify(p.topics),
        p.projectType,
        p.lifecycle,
        p.productScore,
        p.confidence,
        p.verificationLevel,
        p.exposureBand,
        Number(p.treasureEligible),
        Number(p.classicEligible),
        Date.parse(p.analyzedAt),
        JSON.stringify(p.risks),
        p.repoKey,
        Number(p.publishable),
        Number(p.riskOverrideEligible),
        p.repoKey,
        p.sourceHash,
        now,
        command,
      ),
      this.sql(
        "DELETE FROM feed_project_tags WHERE repo_key=? AND EXISTS(SELECT 1 FROM feed_projection_commands WHERE id=? AND applied=1)",
        p.repoKey,
        command,
      ),
      this.sql(
        `${resolve} INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,evidence_json,analysis_id,taxonomy_version,created_at,updated_at)
        SELECT ?,tag_id,MIN(source),MAX(weight),MAX(confidence),MIN(evidence),?,(SELECT version FROM feed_taxonomy_versions WHERE status='active'),?,? FROM resolved WHERE tag_id IS NOT NULL AND EXISTS(SELECT 1 FROM feed_projection_commands WHERE id=? AND applied=1) GROUP BY tag_id`,
        encodedTags,
        p.repoKey,
        p.analysisId,
        now,
        now,
        command,
      ),
      this.sql(
        `${resolve} INSERT INTO feed_tag_proposals(id,repo_key,analysis_id,namespace,slug,label_zh,label_en,evidence_json,status,created_at,updated_at)
        SELECT proposal_id,?,?,namespace,slug,zh,en,evidence,'proposed',?,? FROM resolved WHERE tag_id IS NULL AND EXISTS(SELECT 1 FROM feed_projection_commands WHERE id=? AND applied=1) ON CONFLICT(repo_key,analysis_id,namespace,slug) DO NOTHING`,
        encodedTags,
        p.repoKey,
        p.analysisId,
        now,
        now,
        command,
      ),
      this.sql(
        `INSERT INTO feed_project_source_versions(repo_key,analysis_id,event_id,source_version,receipt_id,source_kind,submitted_at,item_id,resolved_commit_sha,descriptor,descriptor_hash,source_hash,blocked_reason,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM feed_projection_commands WHERE id=? AND applied=1
        ON CONFLICT(repo_key) DO UPDATE SET analysis_id=excluded.analysis_id,event_id=excluded.event_id,source_version=excluded.source_version,receipt_id=excluded.receipt_id,source_kind=excluded.source_kind,submitted_at=excluded.submitted_at,revoked_at=NULL,item_id=excluded.item_id,resolved_commit_sha=excluded.resolved_commit_sha,descriptor=excluded.descriptor,descriptor_hash=excluded.descriptor_hash,source_hash=excluded.source_hash,blocked_reason=excluded.blocked_reason,updated_at=excluded.updated_at`,
        p.repoKey,
        p.analysisId,
        input.eventId,
        input.sourceVersion,
        r.receiptId,
        r.sourceKind,
        Date.parse(r.submittedAt),
        p.itemId,
        p.resolvedCommitSha,
        p.descriptor,
        p.descriptorHash,
        p.sourceHash,
        p.blockedReason,
        now,
        command,
      ),
      this.sql(
        "SELECT applied FROM feed_projection_commands WHERE id=?",
        command,
      ),
      this.sql("DELETE FROM feed_projection_commands WHERE id=?", command),
      this.executionEnd(command),
    ]);
    return {
      duplicate: (result[7].results[0] as { applied: number }).applied !== 1,
    };
  }
}
