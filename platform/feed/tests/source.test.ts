import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hash } from "../src/contract";
import type { SourceEvent } from "../src/source";

const secret = "local-source-test-key-separate-32-characters-minimum";
async function call(operation: string, payload: unknown, key = secret) {
  return exports.default.fetch(
    `https://feed-source.internal/internal/feed/source/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-feed-contract": "1",
      },
      body: JSON.stringify(payload),
    },
  );
}
async function seed(id = "analysis-1"): Promise<SourceEvent> {
  const now = Date.now() - 1000,
    analysis = JSON.stringify({
      analysis_id: id,
      repository: { repo_key: "owner/repo" },
    });
  const digest = await hash(analysis),
    receipt = `app:${id}`,
    event = `assessment.completed:${id}:${digest}`;
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      `INSERT INTO project_analysis_runs(id,repo_key,canonical_url,idempotency_key,status,phase,schema_version,rubric_version,agent_version,skill_version,analysis_json,analysis_sha256,resolved_commit_sha,created_at,updated_at)
      VALUES(?,'owner/repo','https://github.com/owner/repo',?,'completed','completed','v1','v1','v1','v1',?,?,'abc',?,?)`,
    ).bind(id, id, analysis, digest, now, now),
    env.CORE_DB.prepare(
      `INSERT INTO project_assessments(repo_key,latest_analysis_id,project_type,lifecycle,product_score,pain_score,effectiveness_score,experience_score,value_density_score,confidence,verification_level,unknowns_json,risks_json,exposure_band,resolved_commit_sha,rubric_version,analyzed_at,updated_at,treasure_eligible)
      VALUES('owner/repo',?,'micro-tool','active-evolution',87,80,80,80,80,90,'source_inspected','[]','{}','low','abc','v1',?,?,1)
      ON CONFLICT(repo_key) DO UPDATE SET latest_analysis_id=excluded.latest_analysis_id`,
    ).bind(id, now, now),
    env.CORE_DB.prepare(
      `INSERT INTO feed_submission_receipts(id,analysis_id,requested_repo_key,source_kind,submitted_at,evidence_ref)
      VALUES(?,?,'owner/repo','app_submission',?,'POST /api/project-analyses')`,
    ).bind(receipt, id, now),
    env.CORE_DB.prepare(
      `INSERT INTO feed_source_outbox(event_id,aggregate_key,kind,analysis_id,receipt_id,source_hash,occurred_at,available_at)
      VALUES(?,'owner/repo','assessment.completed',?,?,?,?,?)`,
    ).bind(event, id, receipt, digest, now, now),
  ]);
  const sequence = await env.CORE_DB.prepare(
    "SELECT sequence FROM feed_source_outbox WHERE event_id=?",
  )
    .bind(event)
    .first<number>("sequence");
  return {
    contractVersion: 1,
    eventId: event,
    aggregateKey: "owner/repo",
    sourceVersion: sequence!,
    kind: "assessment.completed",
    analysisId: id,
    receiptId: receipt,
    sourceHash: digest,
    occurredAt: now,
  };
}
beforeEach(async () => {
  await env.CORE_DB.batch(
    [
      "feed_source_outbox",
      "feed_submission_receipts",
      "project_assessments",
      "project_analysis_runs",
    ].map((name) => env.CORE_DB.prepare(`DELETE FROM ${name}`)),
  );
});

describe("core source binding capabilities", () => {
  it("uses an independent credential and verifies health against migrated core tables", async () => {
    expect(
      (
        await call(
          "health",
          {},
          "local-test-only-bridge-key-32-characters-minimum",
        )
      ).status,
    ).toBe(401);
    expect(
      (await call("assessment", { sql: "SELECT * FROM users" })).status,
    ).toBe(400);
    const response = await call("health", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ready: true,
      contractVersion: "1",
    });
  });
  it("requires the exact persisted event and receipt and returns only bounded source facts", async () => {
    const event = await seed();
    const response = await call("assessment", event);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "current",
      eventId: event.eventId,
      sourceVersion: event.sourceVersion,
      assessment: {
        repoKey: "owner/repo",
        productScore: 87,
        treasureEligible: true,
      },
      receipt: { receiptId: event.receiptId, sourceKind: "app_submission" },
    });
    for (const changed of [
      { sourceHash: "0".repeat(64) },
      { receiptId: "app:forged" },
      { occurredAt: event.occurredAt + 1 },
    ]) {
      expect((await call("assessment", { ...event, ...changed })).status).toBe(
        409,
      );
    }
    expect(
      (
        await call("assessment", {
          ...event,
          sourceVersion: event.sourceVersion + 100,
        })
      ).status,
    ).toBe(404);
  });
  it("acknowledges supersession only after verifying a newer completed source identity", async () => {
    const first = await seed(),
      next = await seed("analysis-2");
    expect(await (await call("assessment", first)).json()).toEqual({
      status: "superseded",
      eventId: first.eventId,
      sourceVersion: first.sourceVersion,
    });
    await env.CORE_DB.prepare("DELETE FROM feed_source_outbox WHERE sequence=?")
      .bind(next.sourceVersion)
      .run();
    const response = await call("assessment", first);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "source_version_unavailable",
    });
  });
  it("rejects mutated artifacts and incomplete runs even when the envelope matches", async () => {
    const event = await seed();
    await env.CORE_DB.prepare(
      "UPDATE project_analysis_runs SET analysis_json='{}' WHERE id=?",
    )
      .bind(event.analysisId)
      .run();
    expect((await call("assessment", event)).status).toBe(409);
    await env.CORE_DB.prepare(
      "UPDATE project_analysis_runs SET status='failed' WHERE id=?",
    )
      .bind(event.analysisId)
      .run();
    expect((await call("assessment", event)).status).toBe(409);
  });
  it("persists bounded leases and rejects stale acknowledgements after a relay restart", async () => {
    const event = await seed();
    const claims = await call("claim", { limit: 1, leaseToken: "first" });
    expect(await claims.json()).toEqual({
      events: [{ ...event, leaseToken: "first", attempts: 1 }],
    });
    expect(
      await (await call("claim", { limit: 100, leaseToken: "racing" })).json(),
    ).toEqual({ events: [] });
    await env.CORE_DB.prepare(
      "UPDATE feed_source_outbox SET lease_expires_at=0",
    ).run();
    expect(
      await (await call("claim", { limit: 1, leaseToken: "second" })).json(),
    ).toEqual({ events: [{ ...event, leaseToken: "second", attempts: 2 }] });
    expect(
      await (
        await call("finish", {
          sequence: event.sourceVersion,
          leaseToken: "first",
          delivered: true,
        })
      ).json(),
    ).toEqual({ updated: false });
    expect(
      await (
        await call("finish", {
          sequence: event.sourceVersion,
          leaseToken: "second",
          delivered: true,
        })
      ).json(),
    ).toEqual({ updated: true });
    expect(
      await (
        await call("finish", {
          sequence: event.sourceVersion,
          leaseToken: "second",
          delivered: true,
        })
      ).json(),
    ).toEqual({ updated: false });
    expect(
      (await call("claim", { limit: 101, leaseToken: "invalid" })).status,
    ).toBe(400);
  });
  it("recovers exhausted final leases to persisted failure without endless retries", async () => {
    await seed();
    await env.CORE_DB.prepare(
      "UPDATE feed_source_outbox SET status='leased', attempts=10, lease_expires_at=0, lease_token='crashed'",
    ).run();
    expect(
      await (await call("claim", { limit: 100, leaseToken: "next" })).json(),
    ).toEqual({ events: [] });
    expect(
      await env.CORE_DB.prepare(
        "SELECT status,last_error,lease_token FROM feed_source_outbox",
      ).first(),
    ).toEqual({
      status: "failed",
      last_error: "lease_exhausted",
      lease_token: null,
    });
  });
});
