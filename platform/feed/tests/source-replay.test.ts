import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedOperator, operatorSchemas } from "../src/operator";
import { handleSource } from "../src/source";
import { hash } from "../src/contract";

const operator = new FeedOperator(env.FEED_DB, env.CORE_DB);
async function seed(suffix = "one") {
  const analysisId = `analysis-${suffix}`,
    receiptId = `app:${analysisId}`,
    analysisJSON = JSON.stringify({ analysis_id: analysisId });
  const sourceHash = await hash(analysisJSON),
    eventId = `assessment.completed:${analysisId}:${sourceHash}`,
    now = Date.now();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare(
      `INSERT INTO project_analysis_runs(id,repo_key,canonical_url,idempotency_key,status,phase,schema_version,rubric_version,agent_version,skill_version,analysis_json,analysis_sha256,created_at,updated_at)
      VALUES(?,'owner/repo','https://github.com/owner/repo',?,'completed','completed','v1','v1','v1','v1',?,?,?,?)`,
    ).bind(analysisId, analysisId, analysisJSON, sourceHash, now, now),
    env.CORE_DB.prepare(
      `INSERT INTO feed_submission_receipts(id,analysis_id,requested_repo_key,source_kind,submitted_at,evidence_ref)
      VALUES(?,?,'owner/repo','app_submission',?,'POST /api/project-analyses')`,
    ).bind(receiptId, analysisId, now),
    env.CORE_DB.prepare(
      `INSERT INTO feed_source_outbox(event_id,aggregate_key,kind,analysis_id,receipt_id,source_hash,occurred_at,available_at)
      VALUES(?,'owner/repo','assessment.completed',?,?,?,?,0)`,
    ).bind(eventId, analysisId, receiptId, sourceHash, now),
  ]);
  const sequence = (await env.CORE_DB.prepare(
    "SELECT sequence FROM feed_source_outbox WHERE event_id=?",
  )
    .bind(eventId)
    .first<number>("sequence"))!;
  return { id: String(sequence), sequence, eventId, sourceHash };
}
function command(id: string, commandId = crypto.randomUUID()) {
  return operatorSchemas.replay.parse({
    kind: "coreSource",
    id,
    commandId,
    operator: "github-actions-actor",
    reason: "Source queue quota recovered and operator verified",
  });
}
function status(id: string) {
  return operator.status(
    operatorSchemas.status.parse({ kind: "coreSource", id }),
  );
}
beforeEach(async () => {
  await env.CORE_DB.exec("DROP TRIGGER IF EXISTS reject_test_source_command");
  await env.CORE_DB.batch(
    [
      "feed_source_operator_commands",
      "feed_source_operator_guards",
      "feed_source_outbox",
      "feed_submission_receipts",
      "project_assessments",
      "project_analysis_runs",
    ].map((table) => env.CORE_DB.prepare(`DELETE FROM ${table}`)),
  );
});

describe("operator recovery of exhausted core source delivery", () => {
  it("recovers ten failed publications through a durable command and preserves exact source identity", async () => {
    const initial = await seed();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const leaseToken = crypto.randomUUID();
      expect(
        await handleSource("claim", { limit: 1, leaseToken }, env.CORE_DB),
      ).toMatchObject({
        events: [
          {
            sourceVersion: initial.sequence,
            eventId: initial.eventId,
            sourceHash: initial.sourceHash,
            attempts: attempt,
            leaseToken,
          },
        ],
      });
      expect(
        await handleSource(
          "finish",
          {
            sequence: initial.sequence,
            leaseToken,
            delivered: false,
            errorCode: "queue_unavailable",
          },
          env.CORE_DB,
        ),
      ).toEqual({ updated: true });
      await env.CORE_DB.prepare(
        "UPDATE feed_source_outbox SET available_at=0 WHERE sequence=?",
      )
        .bind(initial.sequence)
        .run();
    }
    expect(await status(initial.id)).toMatchObject({
      job: {
        id: initial.id,
        sourceKind: "coreSource",
        sequence: initial.sequence,
        status: "failed",
        attempts: 10,
        replayCount: 0,
      },
    });
    const replay = command(initial.id);
    expect(await operator.replay(replay)).toEqual({ ok: true });
    expect(await operator.replay(replay)).toEqual({ ok: true });
    expect(await status(initial.id)).toMatchObject({
      job: { status: "pending", attempts: 0, replayCount: 1 },
    });
    const leaseToken = crypto.randomUUID();
    expect(
      await handleSource("claim", { limit: 1, leaseToken }, env.CORE_DB),
    ).toMatchObject({
      events: [
        {
          sourceVersion: initial.sequence,
          eventId: initial.eventId,
          sourceHash: initial.sourceHash,
          attempts: 1,
        },
      ],
    });
    // Represents the source relay's durable confirmation after queue.send.
    expect(
      await handleSource(
        "finish",
        { sequence: initial.sequence, leaseToken, delivered: true },
        env.CORE_DB,
      ),
    ).toEqual({ updated: true });
    expect(await operator.replay(replay)).toEqual({ ok: true });
    expect(await status(initial.id)).toMatchObject({
      job: { status: "delivered", attempts: 1, replayCount: 1 },
    });
    const audit = await env.CORE_DB.prepare(
      "SELECT sequence,event_id,source_hash,operator,reason FROM feed_source_operator_commands",
    ).first();
    expect(audit).toEqual({
      sequence: initial.sequence,
      event_id: initial.eventId,
      source_hash: initial.sourceHash,
      operator: replay.operator,
      reason: replay.reason,
    });
    expect(
      await env.CORE_DB.prepare(
        "SELECT count(*) AS n FROM feed_source_operator_commands",
      ).first<number>("n"),
    ).toBe(1);
  });

  it("rejects unknown, pending, leased and delivered sources rather than resetting active transport", async () => {
    expect(await status("999999")).toEqual({ job: null });
    await expect(operator.replay(command("999999"))).rejects.toMatchObject({
      status: 409,
      code: "source_replay_not_allowed",
    });
    const source = await seed();
    await expect(operator.replay(command(source.id))).rejects.toMatchObject({
      status: 409,
      code: "source_replay_not_allowed",
    });
    const leaseToken = crypto.randomUUID();
    await handleSource("claim", { limit: 1, leaseToken }, env.CORE_DB);
    await expect(operator.replay(command(source.id))).rejects.toMatchObject({
      status: 409,
      code: "source_replay_not_allowed",
    });
    await handleSource(
      "finish",
      { sequence: source.sequence, leaseToken, delivered: true },
      env.CORE_DB,
    );
    await expect(operator.replay(command(source.id))).rejects.toMatchObject({
      status: 409,
      code: "source_replay_not_allowed",
    });
    expect(
      await env.CORE_DB.prepare(
        "SELECT count(*) AS n FROM feed_source_operator_commands",
      ).first<number>("n"),
    ).toBe(0);
  });

  it("rejects a reused command with another source, actor or reason, including after a later failure", async () => {
    const source = await seed(),
      other = await seed("two");
    await env.CORE_DB.prepare(
      "UPDATE feed_source_outbox SET status='failed',attempts=10",
    ).run();
    const replay = command(source.id);
    await operator.replay(replay);
    for (const change of [
      { id: other.id },
      { operator: "different-actor" },
      { reason: "Different incident reason" },
    ]) {
      await expect(
        operator.replay({ ...replay, ...change }),
      ).rejects.toMatchObject({ status: 409, code: "source_replay_conflict" });
    }
    // A later independent incident must use a NEW operator command.
    await env.CORE_DB.prepare(
      "UPDATE feed_source_outbox SET status='failed',attempts=10 WHERE sequence=?",
    )
      .bind(source.sequence)
      .run();
    await operator.replay(replay);
    expect(await status(source.id)).toMatchObject({
      job: { status: "failed", attempts: 10, replayCount: 1 },
    });
    await operator.replay(command(source.id));
    expect(await status(source.id)).toMatchObject({
      job: { status: "pending", attempts: 0, replayCount: 2 },
    });
  });

  it("rolls back source reset if command audit insertion fails and serializes competing operators", async () => {
    const source = await seed();
    await env.CORE_DB.prepare(
      "UPDATE feed_source_outbox SET status='failed',attempts=10",
    ).run();
    await env.CORE_DB.exec(
      "CREATE TRIGGER reject_test_source_command BEFORE INSERT ON feed_source_operator_commands BEGIN SELECT RAISE(ABORT,'injected-audit-failure'); END",
    );
    await expect(operator.replay(command(source.id))).rejects.toThrow();
    expect(await status(source.id)).toMatchObject({
      job: { status: "failed", attempts: 10, replayCount: 0 },
    });
    expect(
      await env.CORE_DB.prepare(
        "SELECT count(*) AS n FROM feed_source_operator_guards",
      ).first<number>("n"),
    ).toBe(0);
    await env.CORE_DB.exec("DROP TRIGGER reject_test_source_command");
    const results = await Promise.allSettled([
      operator.replay(command(source.id)),
      operator.replay(command(source.id)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await status(source.id)).toMatchObject({ job: { replayCount: 1 } });
  });

  it("keeps source recovery independent of Feed epochs and exposes only bounded operational fields", async () => {
    const source = await seed();
    await env.CORE_DB.prepare(
      "UPDATE feed_source_outbox SET status='failed',attempts=10",
    ).run();
    const unavailableFeed = new FeedOperator(
      new Proxy(env.FEED_DB, {
        get() {
          throw new Error("Core replay must not access Feed DB");
        },
      }),
      env.CORE_DB,
    );
    expect(await unavailableFeed.replay(command(source.id))).toEqual({
      ok: true,
    });
    const response = await status(source.id);
    expect(Object.keys(response.job!).sort()).toEqual(
      [
        "id",
        "sourceKind",
        "sequence",
        "status",
        "attempts",
        "availableAt",
        "leaseUntil",
        "lastError",
        "replayCount",
        "replayedAt",
      ].sort(),
    );
    expect(
      operatorSchemas.replay.safeParse({
        ...command(source.id),
        writerEpoch: 1,
      }).success,
    ).toBe(false);
    for (const id of ["0", "01", "-1", "1e3", "1.0", "9007199254740992"]) {
      expect(
        operatorSchemas.status.safeParse({ kind: "coreSource", id }).success,
      ).toBe(false);
    }
    expect(
      operatorSchemas.replay.safeParse({
        ...command(source.id),
        sourceKind: "verified_backfill",
      }).success,
    ).toBe(false);
  });

  it("denies the bridge, source relay, executor and delivery credentials at the admin boundary", async () => {
    for (const secret of [
      "local-test-only-bridge-key-32-characters-minimum",
      "local-source-test-key-separate-32-characters-minimum",
      "local-test-only-executor-key-32-characters-minimum",
      "local-test-only-delivery-key-32-characters-minimum",
    ]) {
      const response = await exports.default.fetch(
        "https://adapter.invalid/internal/feed/admin/v1/replay",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            "x-feed-contract": "1",
          },
          body: JSON.stringify(command("1")),
        },
      );
      expect(response.status).toBe(401);
    }
  });
});
