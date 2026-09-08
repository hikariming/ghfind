import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ExecutorInput } from "../src/executor-contract";

const key = "local-test-only-bridge-key-32-characters-minimum",
  leaseOwner = "executor-instance-one";
const event = (version = 1): ExecutorInput<"jobs.claim">["event"] => ({
  contractVersion: 1,
  eventId: `source-event-${version}`,
  aggregateKey: "project-owner/repository",
  sourceVersion: version,
  kind: "assessment.completed",
  analysisId: `analysis-${version}`,
  receiptId: `receipt-${version}`,
  sourceHash: "a".repeat(64),
  occurredAt: Date.now(),
});
const projection = (
  version = 1,
): ExecutorInput<"projection.apply">["projection"] => ({
  repoKey: "project-owner/repository",
  itemId: "project-owner:repository",
  ownerLogin: "project-owner",
  name: "repository",
  canonicalUrl: "https://github.com/project-owner/repository",
  summary: `Summary ${version}`,
  painStatement: "A verified problem.",
  targetUsers: ["developers"],
  language: "Go",
  topics: ["tools"],
  projectType: "micro-tool",
  lifecycle: "active-evolution",
  productScore: 82,
  confidence: 90,
  verificationLevel: "verified",
  exposureBand: "low",
  treasureEligible: true,
  classicEligible: false,
  risks: [],
  analysisId: `analysis-${version}`,
  resolvedCommitSha: "b".repeat(40),
  analyzedAt: new Date().toISOString(),
  descriptor: "approved descriptor",
  descriptorHash: "c".repeat(64),
  sourceHash: "d".repeat(64),
  publishable: true,
  blockedReason: "",
  riskOverrideEligible: false,
  productTags: [
    {
      namespace: "use_case",
      namespaceExplicit: true,
      slug: "unreviewed-tooling",
      labels: { zh: "工具", en: "Tooling" },
      evidenceIds: ["E1"],
    },
  ],
});
async function call(operation: string, payload: unknown) {
  return exports.default.fetch(
    `https://feed-data.internal/internal/feed/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "x-feed-contract": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}
async function success<T>(operation: string, payload: unknown): Promise<T> {
  const r = await call(operation, payload);
  const value = await r.json<T>();
  expect(r.status, JSON.stringify(value)).toBe(200);
  return value;
}
async function claim(e = event(), owner = leaseOwner) {
  return success<{ status: string; attempts: number }>("jobs.claim", {
    writerEpoch: 1,
    event: e,
    leaseOwner: owner,
    leaseSeconds: 90,
  });
}
async function apply(
  e: ReturnType<typeof event>,
  p = projection(e.sourceVersion),
) {
  return call("projection.apply", {
    writerEpoch: 1,
    eventId: e.eventId,
    leaseOwner,
    sourceVersion: e.sourceVersion,
    projection: p,
    receipt: {
      receiptId: e.receiptId,
      sourceKind: "agent_submission",
      submittedAt: new Date().toISOString(),
    },
  });
}
beforeEach(async () => {
  const tables = [
    "feed_execution_jobs",
    "feed_execution_guards",
    "feed_project_source_versions",
    "feed_projection_commands",
    "feed_projects",
    "feed_project_tags",
    "feed_project_moderation",
    "feed_tag_proposals",
    "feed_submission_provenance",
    "feed_user_tag_proposals",
    "feed_tag_proposal_commands",
    "feed_proposal_guards",
    "feed_users",
    "feed_profile_floors",
  ];
  await env.FEED_DB.batch(
    tables.map((table) => env.FEED_DB.prepare(`DELETE FROM ${table}`)),
  );
  await env.FEED_DB.prepare(
    "UPDATE feed_runtime_control SET writer_epoch=1,writes_enabled=1",
  ).run();
});
describe("D1 discrete job leases and ordered projection", () => {
  it("claims exactly one lease and rejects changed immutable event identity", async () => {
    const e = event();
    const results = await Promise.all([claim(e, "one"), claim(e, "two")]);
    expect(results.map((r) => r.status).sort()).toEqual(["busy", "leased"]);
    expect(results.map((r) => r.attempts)).toEqual([1, 1]);
    expect(
      (
        await call("jobs.claim", {
          writerEpoch: 1,
          event: { ...e, sourceHash: "e".repeat(64) },
          leaseOwner,
          leaseSeconds: 90,
        })
      ).status,
    ).toBe(409);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT attempts FROM feed_execution_jobs",
      ).first<{ attempts: number }>())!.attempts,
    ).toBe(1);
  });
  it("requires matching unexpired lease for finish and writer epoch for claim", async () => {
    const e = event();
    await claim(e);
    expect(
      (
        await call("jobs.complete", {
          writerEpoch: 1,
          eventId: e.eventId,
          leaseOwner: "different",
        })
      ).status,
    ).toBe(409);
    await env.FEED_DB.prepare("UPDATE feed_execution_jobs SET lease_until=?")
      .bind(Date.now() - 1)
      .run();
    expect(
      (
        await call("jobs.complete", {
          writerEpoch: 1,
          eventId: e.eventId,
          leaseOwner,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("jobs.claim", {
          writerEpoch: 2,
          event: e,
          leaseOwner,
          leaseSeconds: 90,
        })
      ).status,
    ).toBe(409);
    expect((await claim(e)).attempts).toBe(2);
  });
  it("persists completion so a lost queue ack never reruns the job", async () => {
    const e = event();
    await claim(e);
    await success("jobs.complete", {
      writerEpoch: 1,
      eventId: e.eventId,
      leaseOwner,
    });
    expect(await claim(e, "new-instance")).toEqual({
      status: "completed",
      attempts: 1,
    });
  });
  it("persists bounded backoff and moves exhausted retries into dead letter", async () => {
    const e = event();
    await claim(e);
    for (let attempt = 1; attempt <= 8; attempt++) {
      await success("jobs.fail", {
        writerEpoch: 1,
        eventId: e.eventId,
        leaseOwner,
        errorCode: "source_unavailable",
      });
      const row = await env.FEED_DB.prepare(
        "SELECT status,available_at,updated_at FROM feed_execution_jobs",
      ).first<{ status: string; available_at: number; updated_at: number }>();
      expect(row!.available_at - row!.updated_at).toBeLessThanOrEqual(300000);
      if (attempt < 8) {
        expect((await claim(e)).status).toBe("busy");
        await env.FEED_DB.prepare(
          "UPDATE feed_execution_jobs SET available_at=0",
        ).run();
        expect((await claim(e)).attempts).toBe(attempt + 1);
      }
    }
    expect((await claim(e)).status).toBe("dead_letter");
  });
  it("dead letters the final lease lost during instance restart", async () => {
    const e = event();
    await claim(e);
    await env.FEED_DB.prepare(
      "UPDATE feed_execution_jobs SET attempts=8,lease_until=0",
    ).run();
    expect((await claim(e)).status).toBe("dead_letter");
  });
  it("projects current evidence without approving unknown taxonomy tags", async () => {
    const e = event();
    await claim(e);
    const response = await apply(e);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ duplicate: false });
    const source = await env.FEED_DB.prepare(
      "SELECT source_kind,source_version FROM feed_project_source_versions",
    ).first();
    expect(source).toEqual({
      source_kind: "agent_submission",
      source_version: 1,
    });
    const tags = await env.FEED_DB.prepare(
      "SELECT tag_id FROM feed_project_tags ORDER BY tag_id",
    ).all();
    expect(tags.results).toEqual([
      { tag_id: "artifact:micro-tool" },
      { tag_id: "stage:active-evolution" },
    ]);
    const proposals = await env.FEED_DB.prepare(
      "SELECT status FROM feed_tag_proposals",
    ).all();
    expect(proposals.results).toEqual([{ status: "proposed" }]);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) AS n FROM feed_tag_definitions",
      ).first<{ n: number }>())!.n,
    ).toBe(13);
    const available = await success<{ available: Record<string, boolean> }>(
      "projects.available",
      { githubId: 1, repoKeys: [e.aggregateKey] },
    );
    expect(available.available[e.aggregateKey]).toBe(true);
  });
  it("rejects receipt substitution and does not partially update facts", async () => {
    const e = event();
    await claim(e);
    const response = await call("projection.apply", {
      writerEpoch: 1,
      eventId: e.eventId,
      leaseOwner,
      sourceVersion: e.sourceVersion,
      projection: projection(),
      receipt: {
        receiptId: "forged",
        sourceKind: "app_submission",
        submittedAt: new Date().toISOString(),
      },
    });
    expect(response.status).toBe(409);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) AS n FROM feed_projects",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it("keeps newer version and tag provenance under duplicate and out-of-order delivery", async () => {
    const older = event(1),
      newer = event(2);
    await claim(older);
    await claim(newer);
    expect((await apply(newer)).status).toBe(200);
    const duplicate = await apply(newer);
    expect(await duplicate.json()).toEqual({ duplicate: true });
    const stale = await apply(older);
    expect(await stale.json()).toEqual({ duplicate: true });
    const project = await env.FEED_DB.prepare(
      "SELECT summary,analysis_id FROM feed_projects",
    ).first();
    expect(project).toEqual({
      summary: "Summary 2",
      analysis_id: "analysis-2",
    });
    const tags = await env.FEED_DB.prepare(
      "SELECT DISTINCT analysis_id FROM feed_project_tags",
    ).all();
    expect(tags.results).toEqual([{ analysis_id: "analysis-2" }]);
  });
  it("preserves moderation hard filter during projection", async () => {
    const e = event();
    await env.FEED_DB.prepare(
      "INSERT INTO feed_project_moderation(repo_key,removed,updated_at) VALUES(?,1,?)",
    )
      .bind(e.aggregateKey, Date.now())
      .run();
    await claim(e);
    expect((await apply(e)).status).toBe(200);
    expect(
      (await env.FEED_DB.prepare("SELECT published FROM feed_projects").first<{
        published: number;
      }>())!.published,
    ).toBe(0);
  });
});

describe("user tag proposal contract", () => {
  async function setup() {
    const e = event();
    await claim(e);
    expect((await apply(e)).status).toBe(200);
    await success("users.ensure", {
      writerEpoch: 1,
      expectedProfileVersion: 0,
      githubId: 1,
      login: "actor",
      avatarUrl: "",
    });
    return {
      writerEpoch: 1,
      expectedProfileVersion: 1,
      githubId: 1,
      id: crypto.randomUUID(),
      repoKey: e.aggregateKey,
      namespace: "use_case",
      slug: "new-proposed-tag",
      labelZh: "用途",
      labelEn: "Use case",
      evidence: ["I use this project for a concrete task."],
    };
  }
  it("records user provenance and exact retries, rejects payload mutation", async () => {
    const input = await setup();
    const first = await success<{ proposalId: string; status: string }>(
      "taxonomy.propose",
      input,
    );
    expect(first.status).toBe("proposed");
    expect(await success("taxonomy.propose", input)).toEqual(first);
    expect(
      (await call("taxonomy.propose", { ...input, evidence: ["replacement"] }))
        .status,
    ).toBe(409);
    expect(
      await env.FEED_DB.prepare(
        "SELECT source FROM feed_user_tag_proposals",
      ).first(),
    ).toEqual({ source: "user" });
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) AS n FROM feed_tag_definitions",
      ).first<{ n: number }>())!.n,
    ).toBe(13);
  });
  it("does not overwrite evidence or elevate an existing reviewed proposal", async () => {
    const input = await setup();
    const first = await success<{ proposalId: string }>(
      "taxonomy.propose",
      input,
    );
    await env.FEED_DB.prepare(
      "UPDATE feed_user_tag_proposals SET status='rejected' WHERE id=?",
    )
      .bind(first.proposalId)
      .run();
    expect(
      await success("taxonomy.propose", {
        ...input,
        id: crypto.randomUUID(),
        evidence: ["new evidence"],
      }),
    ).toEqual({ proposalId: first.proposalId, status: "rejected" });
    const row = await env.FEED_DB.prepare(
      "SELECT evidence_json FROM feed_user_tag_proposals",
    ).first<{ evidence_json: string }>();
    expect(JSON.parse(row!.evidence_json)).toEqual(input.evidence);
    expect(
      (await call("taxonomy.propose", { ...input, source: "admin" })).status,
    ).toBe(400);
  });
});
