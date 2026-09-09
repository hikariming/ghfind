import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deliveryEnvelope, initialDelivery, sourceEvent } from "../src/queue";
import { replayDeliveriesOnce } from "../src/delivery";
import { consumeBatch, type QueueMessage } from "../src/consumer";
import { archiveObjects } from "../src/outbound";
import { containerEnvironment } from "../src/environment";
import { runScheduled } from "../src/scheduled";
import type { Dispatch, RuntimeSettings } from "../src/router";

const env: RuntimeSettings = {
  FEED_ENVIRONMENT: "staging",
  FEED_RELEASE_SHA: "a".repeat(40),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${"b".repeat(64)}`,
  FEED_MODE: "baseline",
  FEED_WRITER_EPOCH: "1",
  FEED_EXECUTOR_ENABLED: "true",
  FEED_SOURCE_RELAY_ENABLED: "true",
  FEED_QUEUE_NAME: "ghfind-feed-staging-jobs",
  FEED_DLQ_NAME: "ghfind-feed-staging-dlq",
  FEED_SOURCE_SECRET: "s".repeat(32),
  FEED_DELIVERY_SECRET: "d".repeat(32),
  FEED_GATEWAY_SECRET: "g".repeat(32),
  FEED_SIGNING_SECRET: "i".repeat(32),
  FEED_BRIDGE_SECRET: "b".repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: "o".repeat(32),
  FEED_EXECUTOR_SECRET: "e".repeat(32),
  WORKER_VERSION: {
    id: "worker-version",
    tag: "test",
    timestamp: "2026-09-08T00:00:00Z",
  },
};
const event = sourceEvent({
  contractVersion: 1,
  eventId: "event:1",
  aggregateKey: "owner/repo",
  sourceVersion: 1,
  kind: "assessment.completed",
  analysisId: "analysis",
  receiptId: "receipt",
  sourceHash: "a".repeat(64),
  occurredAt: 1788825600000,
});
const commandId = "12345678-1234-4234-8234-123456789012";
const replay = deliveryEnvelope({
  contractVersion: 1,
  deliveryId: commandId,
  event,
});
const noGo: Dispatch = {
  fetch: async () => assert.fail("must not wake Go"),
  stop: async () => assert.fail("must not stop Go"),
};
const noAdapter = async () => assert.fail("must not call adapter");
function message(body: unknown = initialDelivery(event)) {
  const state = { acked: 0, retries: [] as number[] };
  const value: QueueMessage = {
    body,
    id: "queue-message:1",
    attempts: 2,
    ack() {
      state.acked++;
    },
    retry(v) {
      state.retries.push(v.delaySeconds);
    },
  };
  return { state, value };
}

test("queue wrappers reject raw events, identity mismatches and ungoverned fields", () => {
  assert.equal(initialDelivery(event).deliveryId, "source:1");
  assert.deepEqual(deliveryEnvelope(replay), replay);
  for (const bad of [
    event,
    { ...replay, deliveryId: "source:2" },
    { ...replay, contractVersion: 2 },
    { ...replay, leaseOwner: commandId },
    { ...replay, event: { ...event, rawAssessment: {} } },
    { ...replay, deliveryId: "not-a-command" },
  ])
    assert.throws(() => deliveryEnvelope(bad));
});
test("replay dispatcher uses fresh durable leases and confirms only after bounded queue publication", async () => {
  const owners: string[] = [];
  for (let i = 0; i < 2; i++) {
    let published = false;
    const result = await replayDeliveriesOnce(env, {
      source: async (request) => {
        assert.equal(
          request.headers.get("authorization"),
          `Bearer ${env.FEED_DELIVERY_SECRET}`,
        );
        assert.equal(request.headers.get("x-feed-contract"), "1");
        const body = (await request.json()) as Record<string, unknown>;
        const path = new URL(request.url).pathname;
        if (path.endsWith("/pending")) return Response.json({ pending: true });
        if (path.endsWith("/claim")) {
          assert.equal(body.limit, 20);
          assert.equal(body.leaseSeconds, 60);
          assert.equal(body.writerEpoch, 1);
          owners.push(String(body.leaseOwner));
          return Response.json({
            deliveries: [
              {
                deliveryId: commandId,
                event,
                leaseOwner: body.leaseOwner,
                attempts: 1,
              },
            ],
          });
        }
        assert.equal(published, true);
        assert.equal(body.leaseOwner, owners[i]);
        assert.equal(body.deliveryId, commandId);
        assert.equal(body.delivered, true);
        assert.equal(body.errorCode, undefined);
        return Response.json({ updated: true });
      },
      send: async (wrappers) => {
        assert.deepEqual(wrappers, [replay]);
        published = true;
      },
    });
    assert.equal(result.delivered, 1);
    assert.equal(result.leaseConflicts, 0);
  }
  assert.notEqual(owners[0], owners[1]);
});
test("publication failures and stale confirmations never report successful delivery", async () => {
  for (const conflict of [false, true]) {
    const result = await replayDeliveriesOnce(env, {
      source: async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        const path = new URL(request.url).pathname;
        if (path.endsWith("/pending")) return Response.json({ pending: true });
        if (path.endsWith("/claim"))
          return Response.json({
            deliveries: [
              {
                deliveryId: commandId,
                event,
                leaseOwner: body.leaseOwner,
                attempts: 8,
              },
            ],
          });
        assert.equal(body.delivered, false);
        assert.equal(body.errorCode, "queue_unavailable");
        return Response.json({ updated: !conflict });
      },
      send: async () => {
        throw new Error("injected queue failure");
      },
    });
    assert.equal(result.delivered, 0);
    assert.equal(result.retried, conflict ? 0 : 1);
    assert.equal(result.leaseConflicts, conflict ? 1 : 0);
  }
});
test("foreign, overlarge and malformed replay leases never reach a queue", async () => {
  for (const bad of ["owner", "batch", "event", "duplicate"]) {
    await assert.rejects(
      replayDeliveriesOnce(env, {
        source: async (request) => {
          if (new URL(request.url).pathname.endsWith("/pending"))
            return Response.json({ pending: true });
          const body = (await request.json()) as Record<string, unknown>;
          const item = {
            deliveryId: commandId,
            event: bad === "event" ? { ...event, raw: "forbidden" } : event,
            leaseOwner: bad === "owner" ? "other" : body.leaseOwner,
            attempts: 1,
          };
          return Response.json({
            deliveries: Array.from(
              { length: bad === "batch" ? 21 : bad === "duplicate" ? 2 : 1 },
              () => item,
            ),
          });
        },
        send: async () => assert.fail("invalid leases cannot publish"),
      }),
    );
  }
});
test("DLQ acknowledges only durable terminal evidence, including old generations", async () => {
  for (const current of [true, false]) {
    const { state, value } = message(replay);
    await consumeBatch(
      { queue: env.FEED_DLQ_NAME, messages: [value] },
      env,
      noGo,
      async (request) => {
        assert.equal(state.acked, 0);
        assert.equal(
          request.headers.get("authorization"),
          `Bearer ${env.FEED_DELIVERY_SECRET}`,
        );
        assert.equal(
          new URL(request.url).pathname,
          "/internal/feed/delivery/v1/terminal",
        );
        assert.deepEqual(await request.json(), {
          writerEpoch: 1,
          deliveryId: commandId,
          event,
          messageId: value.id,
          queue: env.FEED_DLQ_NAME,
          attempts: 2,
        });
        return Response.json({ ok: true, current });
      },
      () => {},
    );
    assert.equal(state.acked, 1);
    assert.deepEqual(state.retries, []);
  }
});
test("DLQ transport errors or acceptance without commit retry; malformed messages do not bypass persistence", async () => {
  for (const result of [
    new Response(null, { status: 503 }),
    Response.json({ ok: true }),
    Response.json({ ok: false, current: true }),
  ]) {
    const { state, value } = message();
    await consumeBatch(
      { queue: env.FEED_DLQ_NAME, messages: [value] },
      env,
      noGo,
      async () => result,
      () => {},
    );
    assert.equal(state.acked, 0);
    assert.deepEqual(state.retries, [20]);
  }
  const { state, value } = message(event);
  await consumeBatch(
    { queue: env.FEED_DLQ_NAME, messages: [value] },
    env,
    noGo,
    noAdapter,
    () => {},
  );
  assert.equal(state.acked, 0);
  assert.equal(state.retries.length, 1);
});
test("main consumer sends only source event to Go and rejects unexpected queues or expanded batches", async () => {
  const { state, value } = message(replay);
  const dispatch: Dispatch = {
    ...noGo,
    fetch: async (target, request) => {
      assert.equal(target, "executor-0");
      assert.deepEqual(await request.json(), event);
      assert.equal(
        request.headers.get("authorization"),
        `Bearer ${env.FEED_EXECUTOR_SECRET}`,
      );
      return Response.json({ eventId: event.eventId, status: "duplicate" });
    },
  };
  await consumeBatch(
    { queue: env.FEED_QUEUE_NAME, messages: [value] },
    env,
    dispatch,
    noAdapter,
    () => {},
  );
  assert.equal(state.acked, 1);
  await assert.rejects(
    consumeBatch(
      { queue: "other", messages: [value] },
      env,
      noGo,
      noAdapter,
      () => {},
    ),
  );
  await assert.rejects(
    consumeBatch(
      { queue: env.FEED_QUEUE_NAME, messages: [value, value] },
      env,
      noGo,
      noAdapter,
      () => {},
    ),
  );
});
test("empty source, deletion and replay checks settle without waking any Container", async () => {
  const logs: Record<string, unknown>[] = [];
  await runScheduled(
    env,
    {
      source: async (request) =>
        new URL(request.url).pathname.includes("/source/")
          ? Response.json({ events: [] })
          : Response.json({ pending: false }),
      send: async () => assert.fail("no task to publish"),
    },
    noGo,
    (entry) => logs.push(entry),
  );
  assert.deepEqual(
    logs.map((v) => v.event),
    ["feed_source_relay", "feed_cleanup", "feed_replay_delivery"],
  );
});
test("operator and delivery secrets never enter Go; archive endpoint belongs only to executor", () => {
  for (const role of ["api", "executor"] as const) {
    const result = containerEnvironment(env, role);
    assert.equal(result.FEED_OPERATOR_SECRET, undefined);
    assert.equal(result.FEED_DELIVERY_SECRET, undefined);
    assert.equal(result.FEED_RUNTIME_ADMIN_SECRET, undefined);
    assert.equal(
      result.FEED_SOURCE_SECRET,
      role === "executor" ? env.FEED_SOURCE_SECRET : undefined,
    );
    assert.equal(
      result.FEED_EXECUTOR_SECRET,
      role === "executor" ? env.FEED_EXECUTOR_SECRET : undefined,
    );
    assert.equal(
      result.FEED_GATEWAY_SECRET,
      role === "api" ? env.FEED_GATEWAY_SECRET : undefined,
    );
    assert.equal(
      result.FEED_SIGNING_SECRET,
      role === "api" ? env.FEED_SIGNING_SECRET : undefined,
    );
    assert.equal(
      result.FEED_ARCHIVE_ENDPOINT,
      role === "executor" ? "http://feed-archive.internal" : undefined,
    );
  }
});
function archiveRequest(
  operation: string,
  body: unknown,
  secret = env.FEED_EXECUTOR_SECRET,
) {
  return new Request(
    `http://feed-archive.internal/internal/feed/archive/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-feed-contract": "1",
        "x-client-secret": "do-not-forward",
      },
      body: JSON.stringify(body),
    },
  );
}
test("archive transport handles real 4MiB object bodies without expanding public or bridge limits", async () => {
  const encoded = Buffer.alloc(4 * 1024 * 1024, 42).toString("base64");
  const bindings = {
    ...env,
    FEED_ADAPTER: {
      fetch: async (request: Request) => {
        assert.equal(request.headers.get("x-client-secret"), null);
        if (new URL(request.url).pathname.endsWith("/put")) {
          const body = (await request.json()) as { bodyBase64: string };
          assert.equal(body.bodyBase64, encoded);
          return Response.json({ ok: true });
        }
        return Response.json({ bodyBase64: encoded });
      },
    },
  };
  assert.equal(
    (
      await archiveObjects(
        archiveRequest("put", { bodyBase64: encoded }),
        bindings,
      )
    ).status,
    200,
  );
  const result = await archiveObjects(archiveRequest("get", {}), bindings);
  assert.equal(result.status, 200);
  assert.equal(
    ((await result.json()) as { bodyBase64: string }).bodyBase64,
    encoded,
  );
});
test("archive transport rejects wrong capabilities, oversized decoded bodies and oversized wire data", async () => {
  const blocked = { ...env, FEED_ADAPTER: { fetch: noAdapter } };
  for (const operation of ["delete", "put?arbitrary=1", "../cleanup/v1/claim"])
    assert.equal(
      (await archiveObjects(archiveRequest(operation, {}), blocked)).status,
      401,
    );
  assert.equal(
    (
      await archiveObjects(
        archiveRequest("health", {}, env.FEED_DELIVERY_SECRET),
        blocked,
      )
    ).status,
    401,
  );
  const huge = Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64");
  assert.equal(
    (await archiveObjects(archiveRequest("put", { bodyBase64: huge }), blocked))
      .status,
    413,
  );
  assert.equal(
    (
      await archiveObjects(
        archiveRequest("put", {
          bodyBase64: "",
          extra: "x".repeat(6 * 1024 * 1024),
        }),
        blocked,
      )
    ).status,
    413,
  );
  const response = await archiveObjects(archiveRequest("get", {}), {
    ...env,
    FEED_ADAPTER: { fetch: async () => Response.json({ bodyBase64: huge }) },
  });
  assert.equal(response.status, 413);
});

test("off retries main and DLQ deliveries without execution, terminal writes, or acknowledgements", async () => {
  for (const environment of ["staging", "production"] as const) {
    const paused = {
      ...env,
      FEED_ENVIRONMENT: environment,
      FEED_MODE: "off",
      FEED_QUEUE_NAME: `ghfind-feed-${environment}-jobs`,
      FEED_DLQ_NAME: `ghfind-feed-${environment}-dlq`,
    };
    for (const queue of [paused.FEED_QUEUE_NAME, paused.FEED_DLQ_NAME]) {
      for (const body of [initialDelivery(event), null]) {
        const { state, value } = message(body);
        value.attempts = 100;
        const logs: Record<string, unknown>[] = [];
        await consumeBatch(
          { queue, messages: [value] },
          paused,
          noGo,
          noAdapter,
          (entry) => logs.push(entry),
        );
        assert.equal(state.acked, 0);
        assert.deepEqual(state.retries, [300]);
        assert.equal(logs[0]?.event, "feed_queue_paused");
        assert.equal(JSON.stringify(logs).includes("sourceHash"), false);
      }
    }
    const { value } = message();
    await assert.rejects(
      consumeBatch(
        { queue: "foreign", messages: [value] },
        paused,
        noGo,
        noAdapter,
        () => {},
      ),
      /unexpected_queue/,
    );
    await assert.rejects(
      consumeBatch(
        { queue: paused.FEED_QUEUE_NAME, messages: [value, value] },
        paused,
        noGo,
        noAdapter,
        () => {},
      ),
      /unexpected_queue_batch/,
    );
  }
});
