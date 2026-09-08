/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect JSON capability responses at the wire boundary. */
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedArchive } from "../src/archive";
const bridge = "local-test-only-bridge-key-32-characters-minimum",
  executor = "local-test-only-executor-key-32-characters-minimum",
  operator = "local-test-only-operator-key-32-characters-minimum";
async function call(path: string, input: unknown, secret = executor) {
  return exports.default.fetch(
    `https://feed-data.internal/internal/feed/${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-feed-contract": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}
async function success(path: string, input: unknown, secret = executor) {
  const r = await call(path, input, secret),
    body = await r.json<any>();
  expect(r.status, JSON.stringify(body)).toBe(200);
  return body;
}
async function ensure() {
  return success(
    "v1/users.ensure",
    {
      writerEpoch: 1,
      expectedProfileVersion: 0,
      githubId: 1,
      login: "one",
      avatarUrl: "",
    },
    bridge,
  );
}
async function deletion(version = 1) {
  return success(
    "v1/profile.delete",
    {
      writerEpoch: 1,
      expectedProfileVersion: version,
      githubId: 1,
      now: new Date().toISOString(),
    },
    bridge,
  );
}
async function claim(leaseOwner = crypto.randomUUID()) {
  return {
    ...(await success("cleanup/v1/claim", {
      writerEpoch: 1,
      leaseOwner,
      leaseSeconds: 90,
    })),
    leaseOwner,
  };
}
const lease = (job: any) => ({
  writerEpoch: 1,
  deletionId: job.deletionId,
  leaseOwner: job.leaseOwner,
});
async function until(job: any, phase: string, max = 30) {
  for (let i = 0; i < max; i++) {
    const result = await success("cleanup/v1/step", lease(job));
    expect(result.processed).toBeLessThanOrEqual(100);
    if (result.phase === phase) return result;
  }
  throw new Error("cleanup did not reach phase");
}
beforeEach(async () => {
  const names = [
    "feed_cleanup_jobs",
    "feed_profile_deletions",
    "feed_profile_floors",
    "feed_users",
    "feed_archive_objects",
    "feed_archive_guards",
    "feed_operator_actions",
    "feed_operator_guards",
    "feed_execution_jobs",
    "feed_execution_guards",
    "feed_runtime_outbox",
    "feed_events",
    "feed_runtime_events",
    "feed_served_items",
    "feed_runtime_served_metadata",
    "feed_runtime_requests",
    "feed_user_tag_proposals",
    "feed_user_proposal_authors",
    "feed_tag_proposal_commands",
  ];
  await env.FEED_DB.batch(
    names.map((table) => env.FEED_DB.prepare(`DELETE FROM ${table}`)),
  );
  await env.FEED_DB.prepare(
    "UPDATE feed_runtime_control SET writer_epoch=1,writes_enabled=1",
  ).run();
  await env.FEED_DB.prepare(
    "UPDATE feed_cleanup_policy SET semantic_mode='disabled'",
  ).run();
  for (let i = 0; i < 20; i++) {
    const page = await env.FEED_ARCHIVE.list({ limit: 100 });
    if (!page.objects.length) break;
    await env.FEED_ARCHIVE.delete(page.objects.map((o) => o.key));
  }
});
describe("durable deletion cleanup", () => {
  it("checks pending work read-only and does not wake for future retries", async () => {
    expect(await success("cleanup/v1/pending", {})).toEqual({ pending: false });
    await ensure();
    await deletion();
    expect(await success("cleanup/v1/pending", {})).toEqual({ pending: true });
    const job = await claim();
    expect(await success("cleanup/v1/pending", {})).toEqual({ pending: false });
    await success("cleanup/v1/fail", {
      ...lease(job),
      errorCode: "archive_unavailable",
    });
    expect(await success("cleanup/v1/pending", {})).toEqual({ pending: false });
    await env.FEED_DB.prepare(
      "UPDATE feed_cleanup_jobs SET available_at=0",
    ).run();
    expect(await success("cleanup/v1/pending", {})).toEqual({ pending: true });
    await env.FEED_DB.prepare(
      "UPDATE feed_runtime_control SET writes_enabled=0",
    ).run();
    expect(await success("cleanup/v1/pending", {})).toEqual({ pending: false });
  });
  it("uses executor role and completes all sinks while preserving a new generation", async () => {
    await ensure();
    const archive = new FeedArchive(env.FEED_ARCHIVE, env.FEED_DB);
    await archive.put(1, 1, "old", new TextEncoder().encode('{"old":true}'), 1);
    const d = await deletion();
    await ensure();
    await archive.put(1, 2, "new", new TextEncoder().encode('{"new":true}'), 1);
    expect(
      (
        await call(
          "cleanup/v1/claim",
          { writerEpoch: 1, leaseOwner: "one", leaseSeconds: 90 },
          bridge,
        )
      ).status,
    ).toBe(401);
    const job = await claim();
    expect(job.deletionId).toBe(d.deletionId);
    expect(job.profileFloor).toBe(1);
    await until(job, "completed");
    const status = await success(
      "v1/profile.deletion.get",
      { githubId: 1, deletionId: d.deletionId },
      bridge,
    );
    expect(status.status).toBe("completed");
    const marker = await env.FEED_ARCHIVE.get(archive.key(1, 1, "old"));
    expect(marker!.size).toBe(0);
    expect(marker!.customMetadata!.feedState).toBe("erased");
    expect(await archive.get(1, 1, "old")).toBeNull();
    expect(await (await archive.get(1, 2, "new"))!.text()).toBe('{"new":true}');
  });
  it("blocks delayed create-only writes after deletion's final R2 scan", async () => {
    await ensure();
    const archive = new FeedArchive(env.FEED_ARCHIVE, env.FEED_DB),
      key = archive.key(1, 1, "in-flight");
    await env.FEED_DB.prepare(
      "INSERT INTO feed_archive_objects(object_key,github_id,profile_version,payload_hash,status,created_at) VALUES(?,1,1,'hash','reserved',?)",
    )
      .bind(key, Date.now())
      .run();
    await deletion();
    const job = await claim();
    await until(job, "completed");
    expect(
      await env.FEED_ARCHIVE.put(key, "late user content", {
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    ).toBeNull();
    expect((await env.FEED_ARCHIVE.head(key))!.size).toBe(0);
    await expect(
      archive.put(1, 1, "another", new TextEncoder().encode("{}"), 1),
    ).rejects.toMatchObject({ code: "profile_version_changed" });
  });
  it("checks archive idempotency against exact bytes before writing", async () => {
    await ensure();
    const archive = new FeedArchive(env.FEED_ARCHIVE, env.FEED_DB);
    await archive.put(1, 1, "same", new Uint8Array([255]), 1);
    await expect(
      archive.put(1, 1, "same", new Uint8Array([254]), 1),
    ).rejects.toMatchObject({ code: "archive_id_conflict" });
    expect(
      new Uint8Array(await (await archive.get(1, 1, "same"))!.arrayBuffer()),
    ).toEqual(new Uint8Array([255]));
  });
  it("pages primary and legacy R2 cleanup at 100 and persists progress", async () => {
    await ensure();
    const now = Date.now();
    for (let i = 0; i < 205; i += 40)
      await env.FEED_DB.batch(
        Array.from({ length: Math.min(40, 205 - i) }, (_, j) =>
          env.FEED_DB.prepare(
            "INSERT INTO feed_events(id,github_id,repo_key,type,occurred_at,request_id,rank,created_at) VALUES(?,1,'owner/repo','impression',?,'legacy',0,?)",
          ).bind(`event-${i + j}`, now, now),
        ),
      );
    for (let i = 0; i < 105; i += 5)
      await Promise.all(
        Array.from({ length: Math.min(5, 105 - i) }, (_, j) =>
          env.FEED_ARCHIVE.put(
            `feed/v1/users/1/1/legacy-${i + j}.json`,
            "private",
          ),
        ),
      );
    await deletion();
    const job = await claim();
    await success("cleanup/v1/step", lease(job));
    const page = await success("cleanup/v1/step", lease(job));
    expect(page.processed).toBe(100);
    await success("cleanup/v1/release", lease(job));
    const resumed = await claim();
    expect(resumed.failures).toBe(0);
    await until(resumed, "archive");
    const first = await success("cleanup/v1/step", lease(resumed));
    expect(first.processed).toBe(100);
    expect(first.phase).toBe("archive");
    const second = await success("cleanup/v1/step", lease(resumed));
    expect(second.processed).toBe(5);
    expect(second.phase).toBe("semantic");
    await until(resumed, "completed");
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) AS n FROM feed_events",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it("does not spend failure budget on normal releases", async () => {
    await ensure();
    await deletion();
    for (let i = 0; i < 10; i++) {
      const job = await claim();
      await success("cleanup/v1/release", lease(job));
    }
    const job = await claim();
    expect(job.failures).toBe(0);
    expect(job.attempts).toBe(11);
    await until(job, "completed");
  });
  it("leaves deletion incomplete on actual R2 key rejection and resumes after repair", async () => {
    await ensure();
    const key = "x".repeat(1025);
    await env.FEED_DB.prepare(
      "INSERT INTO feed_archive_objects(object_key,github_id,profile_version,payload_hash,status,created_at) VALUES(?,1,1,'hash','reserved',?)",
    )
      .bind(key, Date.now())
      .run();
    await deletion();
    const job = await claim();
    await until(job, "archive");
    expect((await call("cleanup/v1/step", lease(job))).status).toBe(503);
    const state = await env.FEED_DB.prepare(
      "SELECT status,archive_complete FROM feed_profile_deletions",
    ).first();
    expect(state).toEqual({ status: "running", archive_complete: 0 });
    await success("cleanup/v1/fail", {
      ...lease(job),
      errorCode: "archive_write_failed",
    });
    await env.FEED_DB.prepare(
      "UPDATE feed_archive_objects SET object_key='feed/v1/users/1/1/repaired.json'",
    ).run();
    await env.FEED_DB.prepare(
      "UPDATE feed_cleanup_jobs SET available_at=0",
    ).run();
    const resumed = await claim();
    expect(resumed.failures).toBe(1);
    await until(resumed, "completed");
  });
  it("fails closed if semantic cleanup is required but unavailable", async () => {
    await ensure();
    await deletion();
    await env.FEED_DB.prepare(
      "UPDATE feed_cleanup_policy SET semantic_mode='required'",
    ).run();
    const job = await claim();
    await until(job, "semantic");
    expect((await call("cleanup/v1/step", lease(job))).status).toBe(503);
    expect(
      await env.FEED_DB.prepare(
        "SELECT status,semantic_complete FROM feed_profile_deletions",
      ).first(),
    ).toEqual({ status: "running", semantic_complete: 0 });
  });
  it("recovers an expired lease and rejects the previous executor", async () => {
    await ensure();
    await deletion();
    const first = await claim();
    await env.FEED_DB.prepare(
      "UPDATE feed_cleanup_jobs SET lease_until=0",
    ).run();
    const second = await claim();
    expect(second.failures).toBe(1);
    expect((await call("cleanup/v1/step", lease(first))).status).toBe(409);
    await until(second, "completed");
  });
  it("makes repeated deletion of the same absent generation idempotent", async () => {
    await ensure();
    const first = await deletion();
    const retry = await deletion(0);
    expect(retry.deletionId).toBe(first.deletionId);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) AS n FROM feed_cleanup_jobs",
      ).first<{ n: number }>())!.n,
    ).toBe(1);
  });
});
describe("operator-only persistent replay", () => {
  it("replays a dead-letter source job without changing its immutable envelope", async () => {
    const event = {
      contractVersion: 1,
      eventId: "replay-event",
      aggregateKey: "owner/repo",
      sourceVersion: 1,
      kind: "assessment.completed",
      analysisId: "analysis-one",
      receiptId: "receipt-one",
      sourceHash: "a".repeat(64),
      occurredAt: Date.now(),
    };
    const claim = {
      writerEpoch: 1,
      event,
      leaseOwner: "source-worker",
      leaseSeconds: 90,
    };
    await success("v1/jobs.claim", claim, bridge);
    await env.FEED_DB.prepare(
      "UPDATE feed_execution_jobs SET attempts=8,lease_until=0",
    ).run();
    expect((await success("v1/jobs.claim", claim, bridge)).status).toBe(
      "dead_letter",
    );
    await success(
      "admin/v1/replay",
      {
        writerEpoch: 1,
        kind: "sourceEvent",
        id: event.eventId,
        commandId: crypto.randomUUID(),
        operator: "workflow-actor",
        reason: "Verified source provider recovered",
      },
      operator,
    );
    expect(await success("v1/jobs.claim", claim, bridge)).toMatchObject({
      status: "leased",
      attempts: 1,
    });
    const row = await env.FEED_DB.prepare(
      "SELECT envelope_json FROM feed_execution_jobs",
    ).first<{ envelope_json: string }>();
    expect(JSON.parse(row!.envelope_json)).toEqual(event);
  });
  it("replays only failed work with an audited idempotent command", async () => {
    await ensure();
    const d = await deletion();
    for (let i = 0; i < 8; i++) {
      const failed = await claim();
      await success("cleanup/v1/fail", {
        ...lease(failed),
        errorCode: "archive_unavailable",
      });
      await env.FEED_DB.prepare(
        "UPDATE feed_cleanup_jobs SET available_at=0",
      ).run();
    }
    expect((await claim()).status).toBe("idle");
    expect(
      await env.FEED_DB.prepare(
        "SELECT status,failures FROM feed_cleanup_jobs",
      ).first(),
    ).toEqual({ status: "failed", failures: 8 });
    const input = {
      writerEpoch: 1,
      kind: "deletion",
      id: d.deletionId,
      commandId: crypto.randomUUID(),
      operator: "workflow-actor",
      reason: "Archive provider recovered",
    };
    expect((await call("admin/v1/replay", input, bridge)).status).toBe(401);
    expect((await call("admin/v1/replay", input, executor)).status).toBe(401);
    await success("admin/v1/replay", input, operator);
    await success("admin/v1/replay", input, operator);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) AS n FROM feed_operator_actions",
      ).first<{ n: number }>())!.n,
    ).toBe(1);
    const job = await claim();
    expect(job.failures).toBe(0);
    expect(
      (
        await call(
          "admin/v1/replay",
          { ...input, commandId: crypto.randomUUID() },
          operator,
        )
      ).status,
    ).toBe(409);
    await until(job, "completed");
    expect(
      (
        await call(
          "admin/v1/replay",
          { ...input, commandId: crypto.randomUUID() },
          operator,
        )
      ).status,
    ).toBe(409);
    const status = await success(
      "admin/v1/status",
      { kind: "deletion", id: d.deletionId },
      operator,
    );
    expect(status.job.status).toBe("completed");
  });
});
