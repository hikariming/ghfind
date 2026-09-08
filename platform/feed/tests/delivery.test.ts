/* eslint-disable @typescript-eslint/no-explicit-any -- Inspect JSON capability responses at the wire boundary. */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const deliverySecret = "local-test-only-delivery-key-32-characters-minimum";
const operatorSecret = "local-test-only-operator-key-32-characters-minimum";
const bridgeSecret = "local-test-only-bridge-key-32-characters-minimum";
const event = {
  contractVersion: 1,
  eventId: "delivery-event",
  aggregateKey: "owner/repo",
  sourceVersion: 10,
  kind: "assessment.completed",
  analysisId: "delivery-analysis",
  receiptId: "delivery-receipt",
  sourceHash: "a".repeat(64),
  occurredAt: 1700000000000,
};
async function call(path: string, data: unknown, secret = deliverySecret) {
  return worker.fetch(
    new Request(`https://adapter.invalid/internal/feed/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-contract": "1",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(data),
    }),
    env,
  );
}
async function success(path: string, data: unknown, secret = deliverySecret) {
  const response = await call(path, data, secret);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<Record<string, any>>();
}
function replay(commandId = crypto.randomUUID()) {
  return {
    writerEpoch: 1,
    kind: "sourceEvent",
    id: event.eventId,
    commandId,
    operator: "workflow-actor",
    reason: "Verified source and queue recovered",
  };
}
function terminal(
  deliveryId = `source:${event.sourceVersion}`,
  messageId = "queue-message",
) {
  return {
    writerEpoch: 1,
    deliveryId,
    event,
    messageId,
    queue: "feed-jobs-dlq",
    attempts: 1,
  };
}
async function initialJob() {
  const claim = {
    writerEpoch: 1,
    event,
    leaseOwner: "execution-worker",
    leaseSeconds: 90,
  };
  await success("v1/jobs.claim", claim, bridgeSecret);
  await success(
    "v1/jobs.fail",
    {
      writerEpoch: 1,
      eventId: event.eventId,
      leaseOwner: claim.leaseOwner,
      errorCode: "source_unavailable",
    },
    bridgeSecret,
  );
}
async function dispatchClaim() {
  return success("delivery/v1/claim", {
    writerEpoch: 1,
    leaseOwner: crypto.randomUUID(),
    limit: 20,
    leaseSeconds: 60,
  });
}
beforeEach(async () => {
  await env.FEED_DB.exec("DROP TRIGGER IF EXISTS reject_test_delivery");
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM feed_execution_jobs"),
    env.FEED_DB.prepare("DELETE FROM feed_operator_actions"),
    env.FEED_DB.prepare(
      "UPDATE feed_runtime_control SET writer_epoch=1,writes_enabled=1 WHERE id=1",
    ),
  ]);
});

describe("persistent replay delivery with real D1", () => {
  it("requires transport terminal evidence when queue retries stop before the job retry limit", async () => {
    await initialJob();
    await env.FEED_DB.prepare(
      "UPDATE feed_execution_jobs SET attempts=6",
    ).run();
    const command = replay();
    expect(
      (await call("admin/v1/replay", command, operatorSecret)).status,
    ).toBe(409);
    expect(await success("delivery/v1/terminal", terminal())).toEqual({
      ok: true,
      current: true,
    });
    expect(
      await success("delivery/v1/terminal", { ...terminal(), attempts: 2 }),
    ).toEqual({ ok: true, current: true });
    await success("admin/v1/replay", command, operatorSecret);
    await success("admin/v1/replay", command, operatorSecret);
    expect(await success("delivery/v1/pending", {})).toEqual({ pending: true });
    const status = await success(
      "admin/v1/status",
      { kind: "sourceEvent", id: event.eventId },
      operatorSecret,
    );
    expect(status.job).toMatchObject({ status: "pending", attempts: 0 });
    expect(status.delivery).toMatchObject({
      deliveryId: command.commandId,
      status: "pending",
      attempts: 0,
      publishedAt: null,
    });
    expect(status.terminalEvidence).toMatchObject({
      deliveryId: "source:10",
      attempts: 1,
      isCurrent: false,
    });
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) n FROM feed_replay_deliveries",
      ).first<{ n: number }>())!.n,
    ).toBe(1);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) n FROM feed_delivery_terminals",
      ).first<{ n: number }>())!.n,
    ).toBe(1);
    const claims = await Promise.all([dispatchClaim(), dispatchClaim()]);
    expect(claims.flatMap((c) => c.deliveries)).toHaveLength(1);
    expect(claims.flatMap((c) => c.deliveries)[0]).toMatchObject({
      deliveryId: command.commandId,
      event,
      attempts: 1,
    });
  });

  it("retains dispatch intent on publish failure and republishes the same identity after lost confirmation", async () => {
    await success("delivery/v1/terminal", terminal());
    const command = replay();
    await success("admin/v1/replay", command, operatorSecret);
    const first = (await dispatchClaim()).deliveries[0];
    await success("delivery/v1/finish", {
      writerEpoch: 1,
      deliveryId: first.deliveryId,
      leaseOwner: first.leaseOwner,
      delivered: false,
      errorCode: "queue_unavailable",
    });
    expect((await dispatchClaim()).deliveries).toHaveLength(0);
    await env.FEED_DB.prepare(
      "UPDATE feed_replay_deliveries SET available_at=0",
    ).run();
    const second = (await dispatchClaim()).deliveries[0];
    // Queue accepted second.event, but the dispatcher died before finish.
    await env.FEED_DB.prepare(
      "UPDATE feed_replay_deliveries SET lease_until=0",
    ).run();
    const third = (await dispatchClaim()).deliveries[0];
    expect(third).toMatchObject({
      deliveryId: second.deliveryId,
      event: second.event,
      attempts: 3,
    });
    expect(third.leaseOwner).not.toBe(second.leaseOwner);
    expect(
      await success("delivery/v1/finish", {
        writerEpoch: 1,
        deliveryId: second.deliveryId,
        leaseOwner: second.leaseOwner,
        delivered: true,
      }),
    ).toEqual({ updated: false });
    expect(
      await success("delivery/v1/finish", {
        writerEpoch: 1,
        deliveryId: third.deliveryId,
        leaseOwner: third.leaseOwner,
        delivered: true,
      }),
    ).toEqual({ updated: true });
    const status = await success(
      "admin/v1/status",
      { kind: "sourceEvent", id: event.eventId },
      operatorSecret,
    );
    expect(status.delivery).toMatchObject({ status: "published", attempts: 3 });
    expect(status.delivery.publishedAt).toBeGreaterThan(0);
    expect(status.job.status).toBe("pending");
    expect(await success("delivery/v1/pending", {})).toEqual({
      pending: false,
    });
  });

  it("atomically rolls back job reset and audit when the durable dispatch insert fails", async () => {
    await success("delivery/v1/terminal", terminal());
    await env.FEED_DB.exec(
      "CREATE TRIGGER reject_test_delivery BEFORE INSERT ON feed_replay_deliveries BEGIN SELECT RAISE(ABORT,'test-injected-write-failure'); END",
    );
    const command = replay();
    expect(
      (await call("admin/v1/replay", command, operatorSecret)).status,
    ).toBe(503);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT status FROM feed_execution_jobs",
      ).first<{ status: string }>())!.status,
    ).toBe("dead_letter");
    expect(
      (await env.FEED_DB.prepare(
        "SELECT delivery_id FROM feed_delivery_heads",
      ).first<{ delivery_id: string }>())!.delivery_id,
    ).toBe("source:10");
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) n FROM feed_operator_actions",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
    await env.FEED_DB.exec("DROP TRIGGER reject_test_delivery");
    await success("admin/v1/replay", command, operatorSecret);
  });

  it("does not let stale DLQ evidence or expired acknowledgements terminate the current replay", async () => {
    await success("delivery/v1/terminal", terminal());
    const command = replay();
    await success("admin/v1/replay", command, operatorSecret);
    expect(await success("delivery/v1/terminal", terminal())).toEqual({
      ok: true,
      current: false,
    });
    expect(
      await success(
        "delivery/v1/terminal",
        terminal("source:10", "late-original-copy"),
      ),
    ).toEqual({ ok: true, current: false });
    expect(
      (await env.FEED_DB.prepare(
        "SELECT status FROM feed_execution_jobs",
      ).first<{ status: string }>())!.status,
    ).toBe("pending");
    expect(
      (await call("admin/v1/replay", replay(), operatorSecret)).status,
    ).toBe(409);
    const sourceClaim = {
      writerEpoch: 1,
      event,
      leaseOwner: "active-executor",
      leaseSeconds: 90,
    };
    await success("v1/jobs.claim", sourceClaim, bridgeSecret);
    await success(
      "delivery/v1/terminal",
      terminal(command.commandId, "replay-dlq"),
    );
    expect(
      (await call("admin/v1/replay", replay(), operatorSecret)).status,
    ).toBe(409);
    await env.FEED_DB.prepare(
      "UPDATE feed_execution_jobs SET lease_until=0",
    ).run();
    const next = replay();
    await success("admin/v1/replay", next, operatorSecret);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT status FROM feed_replay_deliveries WHERE delivery_id=?",
      )
        .bind(command.commandId)
        .first<{ status: string }>())!.status,
    ).toBe("superseded");
    expect((await dispatchClaim()).deliveries[0].deliveryId).toBe(
      next.commandId,
    );
  });

  it("recovers a DLQ event whose Go container was never reached and binds all evidence to the immutable envelope", async () => {
    await success("delivery/v1/terminal", terminal());
    expect(
      (
        await call("delivery/v1/terminal", {
          ...terminal(),
          event: { ...event, aggregateKey: "other/repo" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          "delivery/v1/terminal",
          terminal(crypto.randomUUID(), "unregistered-delivery"),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call("delivery/v1/terminal", {
          ...terminal(),
          event: { ...event, eventId: "another-event" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("delivery/v1/terminal", {
          ...terminal("source:10", "different-message"),
          event: {
            ...event,
            eventId: "different-event",
            aggregateKey: "other/repo",
          },
        })
      ).status,
    ).toBe(409);
    const stored = await env.FEED_DB.prepare(
      "SELECT envelope_json FROM feed_execution_jobs",
    ).first<{ envelope_json: string }>();
    expect(JSON.parse(stored!.envelope_json)).toEqual(event);
    const command = replay();
    await success("admin/v1/replay", command, operatorSecret);
    expect(
      (
        await call(
          "admin/v1/replay",
          { ...command, reason: "Different attempted operator reason" },
          operatorSecret,
        )
      ).status,
    ).toBe(409);
    expect((await dispatchClaim()).deliveries[0].event).toEqual(event);
  });

  it("keeps transport failures queryable and permits a new audited replay after bounded dispatch exhaustion", async () => {
    await success("delivery/v1/terminal", terminal());
    const first = replay();
    await success("admin/v1/replay", first, operatorSecret);
    for (let i = 0; i < 7; i++) {
      const delivery = (await dispatchClaim()).deliveries[0];
      await success("delivery/v1/finish", {
        writerEpoch: 1,
        deliveryId: delivery.deliveryId,
        leaseOwner: delivery.leaseOwner,
        delivered: false,
      });
      await env.FEED_DB.prepare(
        "UPDATE feed_replay_deliveries SET available_at=0",
      ).run();
    }
    await dispatchClaim();
    await env.FEED_DB.prepare(
      "UPDATE feed_replay_deliveries SET lease_until=0",
    ).run();
    expect((await dispatchClaim()).deliveries).toHaveLength(0);
    expect(
      (
        await success(
          "admin/v1/status",
          { kind: "sourceEvent", id: event.eventId },
          operatorSecret,
        )
      ).delivery,
    ).toMatchObject({
      status: "failed",
      attempts: 8,
      lastError: "delivery_attempts_exhausted",
    });
    await success("admin/v1/replay", replay(), operatorSecret);
    expect((await dispatchClaim()).deliveries[0].attempts).toBe(1);
  });

  it("isolates terminal evidence and dispatch from bridge, executor and operator credentials and fences writes", async () => {
    for (const key of [
      bridgeSecret,
      operatorSecret,
      "local-test-only-executor-key-32-characters-minimum",
    ]) {
      expect((await call("delivery/v1/terminal", terminal(), key)).status).toBe(
        401,
      );
      expect((await call("delivery/v1/claim", {}, key)).status).toBe(401);
    }
    expect(
      (await call("admin/v1/replay", replay(), deliverySecret)).status,
    ).toBe(401);
    expect(
      (await call("delivery/v1/terminal", { ...terminal(), writerEpoch: 2 }))
        .status,
    ).toBe(409);
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) n FROM feed_execution_jobs",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
    await success("delivery/v1/terminal", terminal());
    await success("admin/v1/replay", replay(), operatorSecret);
    await env.FEED_DB.prepare(
      "UPDATE feed_runtime_control SET writes_enabled=0",
    ).run();
    expect(await success("delivery/v1/pending", {})).toEqual({
      pending: false,
    });
    expect(
      (
        await call("delivery/v1/claim", {
          writerEpoch: 1,
          leaseOwner: crypto.randomUUID(),
          limit: 1,
          leaseSeconds: 60,
        })
      ).status,
    ).toBe(409);
  });

  it("does not reopen completed execution when a duplicated message later enters the DLQ", async () => {
    await success("delivery/v1/terminal", terminal());
    const command = replay();
    await success("admin/v1/replay", command, operatorSecret);
    const claimed = (await dispatchClaim()).deliveries[0];
    await success(
      "v1/jobs.claim",
      {
        writerEpoch: 1,
        event,
        leaseOwner: "completed-worker",
        leaseSeconds: 90,
      },
      bridgeSecret,
    );
    await success(
      "v1/jobs.complete",
      {
        writerEpoch: 1,
        eventId: event.eventId,
        leaseOwner: "completed-worker",
      },
      bridgeSecret,
    );
    await success(
      "delivery/v1/terminal",
      terminal(command.commandId, "completed-late-dlq"),
    );
    expect(
      (await call("admin/v1/replay", replay(), operatorSecret)).status,
    ).toBe(409);
    expect(
      await success("delivery/v1/finish", {
        writerEpoch: 1,
        deliveryId: claimed.deliveryId,
        leaseOwner: claimed.leaseOwner,
        delivered: true,
      }),
    ).toEqual({ updated: false });
    const status = await success(
      "admin/v1/status",
      { kind: "sourceEvent", id: event.eventId },
      operatorSecret,
    );
    expect(status.job.status).toBe("completed");
    expect(status.delivery.status).toBe("cancelled");
    expect(status.delivery.publishedAt).toBeNull();
    expect(await success("delivery/v1/pending", {})).toEqual({
      pending: false,
    });
  });
});
