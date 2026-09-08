import { z } from "zod";
import { BridgeError, hash } from "./contract";
import { FeedStore } from "./store";

const text = (min: number, max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => {
      const bytes = new TextEncoder().encode(value).length;
      return (
        bytes >= min &&
        bytes <= max &&
        (min === 0 || value.trim().length > 0) &&
        !Array.from(value).some((character) => {
          // Array.from keeps valid surrogate pairs together. Lone surrogates
          // cannot have a portable UTF-8/JCS identity across JSON decoders.
          const code = character.codePointAt(0)!;
          return (
            code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)
          );
        })
      );
    });
const integer = z.number().int().safe().positive();
// z.uuid() also accepts the nil and max sentinels, which are not command IDs.
const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
const target = {
  proposalKind: z.enum(["assessment", "user"]),
  proposalId: text(1, 160),
};
const command = {
  commandId: uuid,
  writerEpoch: integer,
  expectedTaxonomyVersion: integer,
  operator: text(1, 100),
  reason: text(8, 500),
};
const review = { ...command, ...target, expectedAnalysisId: text(1, 160) };
const assignment = z.strictObject({
  weight: z.number().finite().min(0).max(1),
  confidence: z.number().finite().min(0).max(1),
});
const labels = z
  .strictObject({
    labelZh: text(0, 160),
    labelEn: text(0, 160),
    description: text(0, 1000),
  })
  .refine((value) => !!(value.labelZh.trim() || value.labelEn.trim()));
export const governanceSchemas = {
  proposal: z.strictObject(target),
  command: z.strictObject({ commandId: uuid }),
  review: z.discriminatedUnion("action", [
    z.strictObject({
      ...review,
      action: z.literal("create"),
      labels,
      assignment,
    }),
    z.strictObject({
      ...review,
      action: z.literal("map"),
      canonicalTagId: text(1, 160),
      assignment,
    }),
    z.strictObject({ ...review, action: z.literal("reject") }),
  ]),
  deprecate: z.strictObject({ ...command, canonicalTagId: text(1, 160) }),
};
export type GovernanceReview = z.infer<typeof governanceSchemas.review>;
export type GovernanceDeprecate = z.infer<typeof governanceSchemas.deprecate>;
type Target = z.infer<typeof governanceSchemas.proposal>;
type Mutation =
  | GovernanceReview
  | (GovernanceDeprecate & { action: "deprecate" });
export type GovernanceResult = {
  commandId: string;
  action: Mutation["action"];
  proposalKind?: Target["proposalKind"];
  proposalId?: string;
  canonicalTagId: string | null;
  status: "mapped" | "rejected" | "deprecated";
  taxonomyVersion: number;
  appliedAt: number;
};
type Proposal = {
  id: string;
  repo_key: string;
  analysis_id: string;
  namespace: string;
  slug: string;
  label_zh: string;
  label_en: string;
  evidence_json: string;
  status: string;
  reviewed_by: string | null;
  review_reason: string | null;
  current_analysis_id: string | null;
  current_evidence: number;
  taxonomy_version: number;
};
const tables = {
  assessment: "feed_tag_proposals",
  user: "feed_user_tag_proposals",
} as const;
const validEvidence = `EXISTS(SELECT 1 FROM feed_projects p WHERE p.repo_key=q.repo_key AND p.analysis_id=q.analysis_id
  AND NOT EXISTS(SELECT 1 FROM feed_project_moderation m WHERE m.repo_key=p.repo_key AND m.removed=1)
  AND (EXISTS(SELECT 1 FROM feed_submission_provenance v WHERE v.repo_key=p.repo_key AND v.analysis_id=p.analysis_id AND v.revoked_at IS NULL)
    OR EXISTS(SELECT 1 FROM feed_project_source_versions v WHERE v.repo_key=p.repo_key AND v.analysis_id=p.analysis_id AND v.revoked_at IS NULL)))`;

function readEvidence(encoded: string): string[] {
  try {
    const evidence = z
      .array(text(0, 256))
      .max(64)
      .safeParse(JSON.parse(encoded));
    if (evidence.success) return evidence.data;
  } catch {
    // Historical assessment rows need not have a json_valid constraint.
  }
  throw new BridgeError(409, "governance_evidence_invalid");
}

// Hash parsed commands with recursively sorted object keys so wire field order
// cannot change idempotency. Arrays retain order; never store raw command bodies.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export class FeedGovernance extends FeedStore {
  private async receipt(commandId: string, digest?: string) {
    const [row] = await this.rows<{
      payload_hash: string;
      result_json: string;
    }>(
      "SELECT payload_hash,result_json FROM feed_governance_commands WHERE command_id=?",
      commandId,
    );
    if (!row) return null;
    if (digest !== undefined && row.payload_hash !== digest)
      throw new BridgeError(409, "governance_command_conflict");
    return JSON.parse(row.result_json) as GovernanceResult;
  }
  async command(input: z.infer<typeof governanceSchemas.command>) {
    return { command: await this.receipt(input.commandId) };
  }
  private async readProposal(input: Target) {
    const [row] = await this.rows<Proposal>(
      `SELECT q.*,p.analysis_id AS current_analysis_id,
      CASE WHEN ${validEvidence} THEN 1 ELSE 0 END AS current_evidence,
      (SELECT version FROM feed_taxonomy_versions WHERE status='active') AS taxonomy_version
      FROM ${tables[input.proposalKind]} q LEFT JOIN feed_projects p ON p.repo_key=q.repo_key WHERE q.id=?`,
      input.proposalId,
    );
    return row;
  }
  async proposal(input: Target) {
    const row = await this.readProposal(input);
    if (!row) return { proposal: null };
    const evidence = readEvidence(row.evidence_json);
    return {
      proposal: {
        ...input,
        repoKey: row.repo_key,
        analysisId: row.analysis_id,
        namespace: row.namespace,
        slug: row.slug,
        labelZh: row.label_zh,
        labelEn: row.label_en,
        evidence,
        status: row.status === "accepted" ? "mapped" : row.status,
        reviewedBy: row.reviewed_by,
        reviewReason: row.review_reason,
        currentAnalysisId: row.current_analysis_id,
        currentEvidence: row.current_evidence === 1,
        taxonomyVersion: row.taxonomy_version,
      },
    };
  }
  async review(input: GovernanceReview) {
    return this.mutate(input);
  }
  async deprecate(input: GovernanceDeprecate) {
    return this.mutate({ ...input, action: "deprecate" });
  }

  private async mutate(input: Mutation): Promise<GovernanceResult> {
    const digest = await hash(canonical(input));
    const existing = await this.receipt(input.commandId, digest);
    if (existing) return existing;
    const isReview = input.action !== "deprecate";
    const row = isReview ? await this.readProposal(input) : undefined;
    if (isReview && !row) {
      // A concurrent exact command can finish and then its user proposal may be
      // erased. Its immutable command receipt remains sufficient for a retry.
      const completed = await this.receipt(input.commandId, digest);
      if (completed) return completed;
      throw new BridgeError(404, "governance_proposal_not_found");
    }
    // Rejection must remain possible for malformed or obsolete stored evidence.
    // Promotion validates it before use; the batch also pins these exact bytes.
    if (row && input.action !== "reject") readEvidence(row.evidence_json);
    if (
      row &&
      input.action !== "reject" &&
      (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) ||
        row.slug.length > 80 ||
        ![
          "domain",
          "use_case",
          "audience",
          "artifact",
          "stack",
          "stage",
        ].includes(row.namespace))
    )
      throw new BridgeError(409, "governance_proposal_changed");
    const tagId =
      input.action === "reject"
        ? null
        : input.action === "create"
          ? `${row!.namespace}:${row!.slug}`
          : input.canonicalTagId;
    const changeTaxonomy = input.action !== "reject";
    const newVersion = input.expectedTaxonomyVersion + Number(changeTaxonomy);
    if (!Number.isSafeInteger(newVersion))
      throw new BridgeError(409, "taxonomy_version_changed");
    const now = Date.now(),
      token = crypto.randomUUID(),
      values: (string | number | null)[] = [];
    const bind = (value: string | number | null) => {
      values.push(value);
      return "?";
    };
    const repeat = `EXISTS(SELECT 1 FROM feed_governance_commands WHERE command_id=${bind(input.commandId)} AND payload_hash=${bind(digest)})`;
    const identity = `NOT EXISTS(SELECT 1 FROM feed_governance_commands WHERE command_id=${bind(input.commandId)} AND payload_hash<>${bind(digest)})`;
    // Keep placeholder order aligned with the SQL below. Only the guard token
    // is interpolated later; it is generated here, never accepted from callers.
    const prefixValues = values.splice(0);
    const writer = `EXISTS(SELECT 1 FROM feed_runtime_control WHERE id=1 AND writer_epoch=${bind(input.writerEpoch)} AND writes_enabled=1)`;
    const taxonomy = `EXISTS(SELECT 1 FROM feed_taxonomy_versions WHERE status='active' AND version=${bind(input.expectedTaxonomyVersion)})${changeTaxonomy ? ` AND NOT EXISTS(SELECT 1 FROM feed_taxonomy_versions WHERE version=${bind(newVersion)})` : ""}`;
    const table = isReview ? tables[input.proposalKind] : "feed_tag_proposals";
    const proposal =
      row && isReview
        ? `EXISTS(SELECT 1 FROM ${table} q WHERE q.id=${bind(input.proposalId)} AND q.analysis_id=${bind(input.expectedAnalysisId)} AND q.analysis_id=${bind(row.analysis_id)} AND q.namespace=${bind(row.namespace)} AND q.slug=${bind(row.slug)} AND q.evidence_json=${bind(row.evidence_json)} AND q.label_zh=${bind(row.label_zh)} AND q.label_en=${bind(row.label_en)})`
        : "1";
    const pending =
      row && isReview
        ? `EXISTS(SELECT 1 FROM ${table} WHERE id=${bind(input.proposalId)} AND status='proposed')`
        : `EXISTS(SELECT 1 FROM feed_tag_definitions WHERE id=${bind(tagId)} AND status='canonical' AND taxonomy_version<=${bind(input.expectedTaxonomyVersion)})`;
    const evidence =
      row && input.action !== "reject"
        ? `EXISTS(SELECT 1 FROM ${table} q WHERE q.id=${bind(row.id)} AND ${validEvidence})`
        : "1";
    const tagIdentity =
      input.action === "create"
        ? `NOT EXISTS(SELECT 1 FROM feed_tag_definitions WHERE id=${bind(tagId)} OR (namespace=${bind(row!.namespace)} AND slug=${bind(row!.slug)})) AND NOT EXISTS(SELECT 1 FROM feed_tag_aliases WHERE namespace=${bind(row!.namespace)} AND slug=${bind(row!.slug)})`
        : input.action === "map"
          ? `EXISTS(SELECT 1 FROM feed_tag_definitions WHERE id=${bind(tagId)} AND namespace=${bind(row!.namespace)} AND status='canonical' AND taxonomy_version<=${bind(input.expectedTaxonomyVersion)}) AND NOT EXISTS(SELECT 1 FROM feed_tag_aliases WHERE namespace=${bind(row!.namespace)} AND slug=${bind(row!.slug)} AND canonical_tag_id<>${bind(tagId)}) AND NOT EXISTS(SELECT 1 FROM feed_tag_definitions WHERE namespace=${bind(row!.namespace)} AND slug=${bind(row!.slug)} AND (id<>${bind(tagId)} OR status<>'canonical'))`
          : "1";
    const tagCapacity =
      row && (input.action === "create" || input.action === "map")
        ? `EXISTS(SELECT 1 FROM feed_project_tags t JOIN feed_tag_definitions d ON d.id=t.tag_id AND d.status='canonical' AND d.taxonomy_version<=${bind(input.expectedTaxonomyVersion)} WHERE t.repo_key=${bind(row.repo_key)} AND t.tag_id=${bind(tagId)} AND t.analysis_id=${bind(row.analysis_id)}) OR (SELECT COUNT(*) FROM feed_project_tags t JOIN feed_tag_definitions d ON d.id=t.tag_id AND d.status='canonical' AND d.taxonomy_version<=${bind(input.expectedTaxonomyVersion)} WHERE t.repo_key=${bind(row.repo_key)} AND t.analysis_id=${bind(row.analysis_id)})<100`
        : "1";
    const tag = `(${tagIdentity}) AND (${tagCapacity})`;
    const allowed = `EXISTS(SELECT 1 FROM feed_governance_guards WHERE id='${token}' AND apply=1)`;
    const result: GovernanceResult = {
      commandId: input.commandId,
      action: input.action,
      ...(isReview
        ? { proposalKind: input.proposalKind, proposalId: input.proposalId }
        : {}),
      canonicalTagId: tagId,
      status:
        input.action === "deprecate"
          ? "deprecated"
          : input.action === "reject"
            ? "rejected"
            : "mapped",
      taxonomyVersion: newVersion,
      appliedAt: now,
    };
    const statements = [
      this.sql(
        `WITH retry AS (SELECT CASE WHEN ${repeat} THEN 1 ELSE 0 END AS duplicate)
      INSERT INTO feed_governance_guards(id,identity_ok,writer_ok,taxonomy_ok,proposal_ok,state_ok,evidence_ok,tag_ok,apply)
      SELECT '${token}',CASE WHEN ${identity} THEN 1 ELSE 0 END,
      CASE WHEN duplicate=1 OR (${writer}) THEN 1 ELSE 0 END,
      CASE WHEN duplicate=1 OR (${taxonomy}) THEN 1 ELSE 0 END,
      CASE WHEN duplicate=1 OR (${proposal}) THEN 1 ELSE 0 END,
      CASE WHEN duplicate=1 OR (${pending}) THEN 1 ELSE 0 END,
      CASE WHEN duplicate=1 OR (${evidence}) THEN 1 ELSE 0 END,
      CASE WHEN duplicate=1 OR (${tag}) THEN 1 ELSE 0 END,1-duplicate FROM retry`,
        ...prefixValues,
        ...values,
      ),
    ];
    if (changeTaxonomy)
      statements.push(
        this.sql(
          `UPDATE feed_taxonomy_versions SET status='retired' WHERE status='active' AND ${allowed}`,
        ),
        this.sql(
          `INSERT INTO feed_taxonomy_versions(version,status,created_at) SELECT ?,'active',? WHERE ${allowed}`,
          newVersion,
          now,
        ),
      );
    if (input.action === "create")
      statements.push(
        this.sql(
          `INSERT INTO feed_tag_definitions(id,namespace,slug,label_zh,label_en,description,status,taxonomy_version,created_at,updated_at) SELECT ?,?,?,?,?,?,'canonical',?,?,? WHERE ${allowed}`,
          tagId,
          row!.namespace,
          row!.slug,
          input.labels.labelZh,
          input.labels.labelEn,
          input.labels.description,
          newVersion,
          now,
          now,
        ),
      );
    if (input.action === "map")
      statements.push(
        this.sql(
          `INSERT INTO feed_tag_aliases(namespace,slug,canonical_tag_id,taxonomy_version,created_at)
      SELECT ?,?,?,?,? WHERE ${allowed} AND NOT EXISTS(SELECT 1 FROM feed_tag_definitions WHERE namespace=? AND slug=?) ON CONFLICT(namespace,slug) DO NOTHING`,
          row!.namespace,
          row!.slug,
          tagId,
          newVersion,
          now,
          row!.namespace,
          row!.slug,
        ),
      );
    if (input.action === "deprecate")
      statements.push(
        this.sql(
          `UPDATE feed_tag_definitions SET status='deprecated',taxonomy_version=?,updated_at=? WHERE id=? AND ${allowed}`,
          newVersion,
          now,
          tagId,
        ),
      );
    else {
      if (input.action !== "reject")
        statements.push(
          this.sql(
            `INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,evidence_json,analysis_id,taxonomy_version,created_at,updated_at)
        SELECT ?,?,'admin',?,?,?,?,?,?,? WHERE ${allowed} ON CONFLICT(repo_key,tag_id) DO UPDATE SET source='admin',weight=excluded.weight,confidence=excluded.confidence,evidence_json=excluded.evidence_json,analysis_id=excluded.analysis_id,taxonomy_version=excluded.taxonomy_version,updated_at=excluded.updated_at`,
            row!.repo_key,
            tagId,
            input.assignment.weight,
            input.assignment.confidence,
            row!.evidence_json,
            row!.analysis_id,
            newVersion,
            now,
            now,
          ),
        );
      const physicalStatus =
        input.action === "reject"
          ? "rejected"
          : input.proposalKind === "assessment"
            ? "accepted"
            : "mapped";
      statements.push(
        this.sql(
          `UPDATE ${table} SET status=?,reviewed_by=?,review_reason=?,updated_at=? WHERE id=? AND ${allowed}`,
          physicalStatus,
          input.operator,
          input.reason,
          now,
          input.proposalId,
        ),
      );
    }
    statements.push(
      this.sql(
        `INSERT INTO feed_governance_commands(command_id,action,writer_epoch,expected_taxonomy_version,proposal_kind,proposal_id,repo_key,analysis_id,evidence_hash,canonical_tag_id,assignment_weight,assignment_confidence,operator,reason,payload_hash,result_json,taxonomy_version,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${allowed}`,
        input.commandId,
        input.action,
        input.writerEpoch,
        input.expectedTaxonomyVersion,
        isReview ? input.proposalKind : null,
        isReview ? input.proposalId : null,
        row?.repo_key ?? null,
        row?.analysis_id ?? null,
        row ? await hash(row.evidence_json) : null,
        tagId,
        "assignment" in input ? input.assignment.weight : null,
        "assignment" in input ? input.assignment.confidence : null,
        input.operator,
        input.reason,
        digest,
        JSON.stringify(result),
        newVersion,
        now,
      ),
      this.sql(
        "SELECT result_json FROM feed_governance_commands WHERE command_id=?",
        input.commandId,
      ),
      this.sql("DELETE FROM feed_governance_guards WHERE id=?", token),
    );
    try {
      const response = await this.db.batch<{ result_json: string }>(statements);
      return JSON.parse(
        response.at(-2)!.results[0].result_json,
      ) as GovernanceResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      for (const code of [
        "governance_command_conflict",
        "writer_epoch_changed",
        "taxonomy_version_changed",
        "governance_proposal_changed",
        "governance_not_pending",
        "governance_evidence_changed",
        "governance_tag_conflict",
      ])
        if (message.includes(code)) throw new BridgeError(409, code);
      throw error;
    }
  }
}

// The entry Worker must route this family exclusively through OPERATOR auth;
// this capability dispatcher never accepts bearer credentials or public roles.
export async function handleGovernance(
  operation: string,
  raw: unknown,
  db: D1Database,
) {
  const store = new FeedGovernance(db);
  switch (operation) {
    case "proposal": {
      const parsed = governanceSchemas.proposal.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.proposal(parsed.data);
    }
    case "command": {
      const parsed = governanceSchemas.command.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.command(parsed.data);
    }
    case "review": {
      const parsed = governanceSchemas.review.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.review(parsed.data);
    }
    case "deprecate": {
      const parsed = governanceSchemas.deprecate.safeParse(raw);
      if (!parsed.success) throw new BridgeError(400, "invalid_request");
      return store.deprecate(parsed.data);
    }
    default:
      throw new BridgeError(404, "operation_not_found");
  }
}
