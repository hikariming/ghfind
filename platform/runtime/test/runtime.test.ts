import { strict as assert } from "node:assert";
import { createHmac, createHash } from "node:crypto";
import { test } from "node:test";
import {
  handleRequest,
  type Dispatch,
  type RuntimeSettings,
  type Target,
} from "../src/router";
import { deliver, sourceEvent, initialDelivery } from "../src/queue";
import { relayOnce } from "../src/relay";
import { cleanupOnce, runScheduled } from "../src/scheduled";
import { deletionCleanup, bindingBridge, executorBindingBridge } from "../src/outbound";
import { handleAdminRequest } from "../src/admin";
import { readBounded, HTTPError } from "../src/security";

const env: RuntimeSettings = {
  FEED_ENVIRONMENT: "staging",
  FEED_DELIVERY_SECRET: "d".repeat(32),
  FEED_QUEUE_NAME: "ghfind-feed-staging-jobs",
  FEED_DLQ_NAME: "ghfind-feed-staging-dlq",
  FEED_SOURCE_RELAY_ENABLED: "true",
  FEED_SOURCE_SECRET: "o".repeat(32),
  FEED_RELEASE_SHA: "a".repeat(40),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${"b".repeat(64)}`,
  FEED_MODE: "baseline",
  FEED_WRITER_EPOCH: "1",
  FEED_EXECUTOR_ENABLED: "true",
  FEED_GATEWAY_SECRET: "g".repeat(32),
  FEED_SIGNING_SECRET: "s".repeat(32),
  FEED_BRIDGE_SECRET: "b".repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: "a".repeat(32),
  FEED_EXECUTOR_SECRET: "e".repeat(32),
  WORKER_VERSION: {
    id: "worker-version",
    tag: "test",
    timestamp: "2026-09-08T00:00:00Z",
  },
};
function signed(body = "", change: Record<string, unknown> = {}): Request {
  const now = Date.now();
  const claims = {
    version: 1,
    audience: "feed-api",
    githubId: 12,
    login: "test-user",
    issuedAt: now,
    expiresAt: now + 30000,
    method: "POST",
    target: "/api/feed/events?a=1",
    bodySha256: createHash("sha256").update(body).digest("hex"),
    ...change,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", env.FEED_GATEWAY_SECRET)
    .update(`feed-gateway-v1\n${payload}`)
    .digest("base64url");
  return new Request("https://runtime/api/feed/events?a=1", {
    method: "POST",
    body,
    headers: {
      "x-feed-gateway": `${payload}.${signature}`,
      cookie: "private",
      "x-github-id": "999",
      "user-agent": "untrusted",
      authorization: "Bearer fake",
    },
  });
}
function dispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    fetch: async (target) =>
      Response.json({
        ready: true,
        service: target === "executor-0" ? "feed-worker" : "feed-api",
        version: env.FEED_RELEASE_SHA,
        contractVersion: "1",
        storeProfile: "cf_d1_r2",
        writerEpoch: 1,
      }),
    stop: async () => {},
    ...overrides,
  };
}
function admin(path: string, method = "GET") {
  return new Request(`https://runtime${path}`, {
    method,
    headers: { authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}` },
  });
}

test("anonymous callers cannot wake containers or access operations", async () => {
  let calls = 0;
  const d = dispatch({
    fetch: async () => {
      calls++;
      throw new Error("must not dispatch");
    },
  });
  for (const path of [
    "/api/feed/events",
    "/readyz",
    "/internal/runtime/api-0/ready",
  ]) {
    const result = await handleRequest(
      new Request(`https://runtime${path}`),
      env,
      d,
    );
    assert.equal(result.status, 401);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
});
test("valid request binds identity/body/target and strips untrusted headers", async () => {
  const response = await handleRequest(
    signed('{"events":[]}'),
    env,
    dispatch({
      fetch: async (target, request) => {
        assert.equal(target, "api-0");
        for (const header of [
          "cookie",
          "x-github-id",
          "authorization",
          "user-agent",
        ])
          assert.equal(request.headers.get(header), null);
        assert.equal(await request.text(), '{"events":[]}');
        return Response.json(
          { ok: true },
          { headers: { "x-internal-score": "secret", "set-cookie": "bad" } },
        );
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-internal-score"), null);
  assert.equal(response.headers.get("set-cookie"), null);
});
test("tampered, stale, wrong-audience and wrong-body claims reject before dispatch", async () => {
  const d = dispatch({
    fetch: async () => {
      throw new Error("must not dispatch");
    },
  });
  for (const changes of [
    { target: "/api/feed/events" },
    { audience: "other" },
    { bodySha256: "0".repeat(64) },
    { expiresAt: Date.now() - 10000 },
    { githubId: 0 },
    { issuedAt: Date.now() + 60000 },
  ]) {
    assert.equal(
      (await handleRequest(signed("{}", changes), env, d)).status,
      401,
    );
  }
  const req = signed();
  req.headers.set("x-feed-gateway", "a.b");
  assert.equal((await handleRequest(req, env, d)).status, 401);
});
test("actual streaming size is bounded when Content-Length is absent", async () => {
  const response = await handleRequest(
    signed("x".repeat(128 * 1024 + 1)),
    env,
    dispatch(),
  );
  assert.equal(response.status, 413);
});
test("readiness requires all fixed slots, current binary and contract", async () => {
  const targets: Target[] = [];
  const response = await handleRequest(
    admin("/readyz"),
    env,
    dispatch({
      fetch: async (target, request) => {
        targets.push(target);
        return dispatch().fetch(target, request);
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(targets.sort(), ["api-0", "api-1", "executor-0"]);
  const mismatch = dispatch({
    fetch: async () =>
      Response.json({ ready: true, version: "old", contractVersion: "1" }),
  });
  assert.equal(
    (await handleRequest(admin("/readyz"), env, mismatch)).status,
    503,
  );
  assert.equal(
    (
      await handleRequest(
        admin("/readyz"),
        { ...env, FEED_EXECUTOR_ENABLED: "false" },
        dispatch(),
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await handleRequest(
        admin("/readyz"),
        { ...env, FEED_RELEASE_SHA: "UNCONFIGURED" },
        dispatch(),
      )
    ).status,
    503,
  );
});
test("stops are staging-only and arbitrary instance identifiers cannot expand capacity", async () => {
  let stops = 0;
  const d = dispatch({
    stop: async (target) => {
      assert.equal(target, "api-0");
      stops++;
    },
  });
  assert.equal(
    (
      await handleRequest(
        admin("/internal/runtime/api-99/stop", "POST"),
        env,
        d,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await handleRequest(
        admin("/internal/runtime/api-0/stop", "POST"),
        {
          ...env,
          FEED_ENVIRONMENT: "production",
          FEED_QUEUE_NAME: "ghfind-feed-production-jobs",
          FEED_DLQ_NAME: "ghfind-feed-production-dlq",
        },
        d,
      )
    ).status,
    405,
  );
  assert.equal(
    (await handleRequest(admin("/internal/runtime/api-0/stop", "POST"), env, d))
      .status,
    200,
  );
  assert.equal(stops, 1);
});
const event = {
  contractVersion: 1,
  eventId: "event:1",
  aggregateKey: "owner/repo",
  sourceVersion: 1,
  kind: "assessment.completed",
  analysisId: "analysis",
  receiptId: "receipt",
  sourceHash: "a".repeat(64),
  occurredAt: Date.now(),
};
test("queue completion requires durable outcome for the exact event", async () => {
  for (const result of [
    { status: "accepted", eventId: event.eventId },
    { status: "completed", eventId: "other" },
  ]) {
    await assert.rejects(
      deliver(
        initialDelivery(sourceEvent(event)),
        env,
        dispatch({ fetch: async () => Response.json(result) }),
      ),
    );
  }
  for (const status of ["completed", "duplicate"]) {
    await deliver(
      initialDelivery(sourceEvent(event)),
      env,
      dispatch({
        fetch: async (target, request) => {
          assert.equal(target, "executor-0");
          assert.equal(
            new URL(request.url).pathname,
            "/internal/feed/jobs/execute",
          );
          assert.equal(
            request.headers.get("authorization"),
            `Bearer ${env.FEED_EXECUTOR_SECRET}`,
          );
          return Response.json({ status, eventId: event.eventId });
        },
      }),
    );
  }
  assert.throws(() =>
    sourceEvent({ ...event, analysis: { raw: "forbidden" } }),
  );
});

test("source relay sends bounded reference envelopes before marking delivery", async () => {
  let queued = false;
  let finishes = 0;
  const summary = await relayOnce(env, {
    source: async (request) => {
      assert.equal(
        request.headers.get("authorization"),
        `Bearer ${env.FEED_SOURCE_SECRET}`,
      );
      assert.equal(request.headers.get("x-feed-contract"), "1");
      const body = (await request.json()) as Record<string, unknown>;
      if (new URL(request.url).pathname.endsWith("/claim")) {
        assert.equal(body.limit, 100);
        return Response.json({
          events: [{ ...event, leaseToken: body.leaseToken, attempts: 2 }],
        });
      }
      assert.equal(queued, true);
      assert.equal(body.delivered, true);
      assert.equal(body.sequence, event.sourceVersion);
      assert.equal(body.errorCode, undefined);
      finishes++;
      return Response.json({ updated: true });
    },
    send: async (events) => {
      assert.deepEqual(events, [initialDelivery(sourceEvent(event))]);
      queued = true;
    },
  });
  assert.equal(finishes, 1);
  assert.deepEqual(summary, {
    claimed: 1,
    delivered: 1,
    retried: 0,
    leaseConflicts: 0,
    disabled: false,
  });
});
test("failed publication stays retryable and expired finish cannot claim success", async () => {
  for (const conflict of [false, true]) {
    const summary = await relayOnce(env, {
      source: async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (new URL(request.url).pathname.endsWith("/claim"))
          return Response.json({
            events: [{ ...event, leaseToken: body.leaseToken, attempts: 1 }],
          });
        assert.equal(body.delivered, false);
        assert.equal(body.errorCode, "queue_unavailable");
        return Response.json({ updated: !conflict });
      },
      send: async () => {
        throw new Error("queue unavailable");
      },
    });
    assert.equal(summary.delivered, 0);
    assert.equal(summary.retried, conflict ? 0 : 1);
    assert.equal(summary.leaseConflicts, conflict ? 1 : 0);
  }
});
test("relay rejects foreign leases, raw assessment data and oversized claims before publication", async () => {
  for (const kind of ["wrong-lease", "raw-data", "too-many"]) {
    let publications = 0;
    await assert.rejects(
      relayOnce(env, {
        source: async (request) => {
          const body = (await request.json()) as Record<string, unknown>;
          const value = {
            ...event,
            leaseToken: kind === "wrong-lease" ? "foreign" : body.leaseToken,
            attempts: 1,
            ...(kind === "raw-data" ? { rawAssessment: "forbidden" } : {}),
          };
          return Response.json({
            events: Array.from(
              { length: kind === "too-many" ? 101 : 1 },
              () => value,
            ),
          });
        },
        send: async () => {
          publications++;
        },
      }),
    );
    assert.equal(publications, 0);
  }
  const result = await relayOnce(
    { ...env, FEED_SOURCE_RELAY_ENABLED: "false" },
    {
      source: async () => {
        throw new Error("disabled must not read");
      },
      send: async () => {
        throw new Error("disabled must not send");
      },
    },
  );
  assert.equal(result.disabled, true);
});

test("slow bodies expire without waiting for a stalled stream cancellation", async () => {
  const response = new Response(
    new ReadableStream({
      pull() {},
      cancel() {
        return new Promise(() => {});
      },
    }),
  );
  await assert.rejects(
    readBounded(response, 128, 20),
    (error: unknown) => error instanceof HTTPError && error.status === 408,
  );
});

test("idle cleanup polls durable pending state without waking a Container", async () => {
  let reads = 0;
  const result = await cleanupOnce(
    env,
    async (request) => {
      reads++;
      assert.equal(
        new URL(request.url).pathname,
        "/internal/feed/cleanup/v1/pending",
      );
      assert.equal(
        request.headers.get("authorization"),
        `Bearer ${env.FEED_EXECUTOR_SECRET}`,
      );
      assert.equal(request.headers.get("x-feed-contract"), "1");
      assert.equal(await request.text(), "{}");
      return Response.json({ pending: false });
    },
    dispatch({
      fetch: async () => {
        assert.fail("idle cleanup must not wake");
      },
    }),
  );
  assert.equal(reads, 1);
  assert.equal(result.skipped, true);
  assert.equal(result.status, "idle");
});
test("due cleanup invokes Go once and validates a bounded durable outcome", async () => {
  let calls = 0;
  const d = dispatch({
    fetch: async (target, request) => {
      calls++;
      assert.equal(target, "executor-0");
      assert.equal(
        new URL(request.url).pathname,
        "/internal/feed/jobs/cleanup",
      );
      assert.equal(
        request.headers.get("authorization"),
        `Bearer ${env.FEED_EXECUTOR_SECRET}`,
      );
      assert.equal(await request.text(), "{}");
      return Response.json({
        status: "queued",
        deletionId: "deletion:1",
        steps: 8,
        processed: 800,
      });
    },
  });
  assert.deepEqual(
    await cleanupOnce(env, async () => Response.json({ pending: true }), d),
    { status: "queued", steps: 8, processed: 800, skipped: false },
  );
  assert.equal(calls, 1);
  for (const outcome of [
    { status: "accepted", steps: 1, processed: 1 },
    { status: "completed", deletionId: "deletion:1", steps: 9, processed: 900 },
    { status: "completed", steps: 1, processed: 1 },
  ]) {
    await assert.rejects(
      cleanupOnce(
        env,
        async () => Response.json({ pending: true }),
        dispatch({ fetch: async () => Response.json(outcome) }),
      ),
    );
  }
});
test("relay failure cannot starve cleanup and both cron branches are awaited", async () => {
  let cleaned = false;
  const logs: Record<string, unknown>[] = [];
  await assert.rejects(
    runScheduled(
      env,
      {
        source: async (request) =>
          new URL(request.url).pathname.endsWith("/pending")
            ? Response.json({ pending: true })
            : new Response(null, { status: 503 }),
        send: async () => {
          assert.fail("failed claim cannot send");
        },
      },
      dispatch({
        fetch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          cleaned = true;
          return Response.json({
            status: "completed",
            deletionId: "deletion:private",
            steps: 2,
            processed: 30,
          });
        },
      }),
      (entry) => {
        logs.push(entry);
      },
    ),
    /feed_source_relay/,
  );
  assert.equal(cleaned, true);
  assert.equal(
    logs.some((v) => v.event === "feed_cleanup" && v.status === "completed"),
    true,
  );
  assert.equal(JSON.stringify(logs).includes("deletion:private"), false);
});
test("cleanup failure cannot prevent source queue publication and errors stay separate", async () => {
  let sent = 0;
  let confirmed = 0;
  const logs: Record<string, unknown>[] = [];
  await assert.rejects(
    runScheduled(
      env,
      {
        source: async (request) => {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/pending"))
            return new Response(null, { status: 503 });
          const body = (await request.json()) as Record<string, unknown>;
          if (path.endsWith("/claim"))
            return Response.json({
              events: [{ ...event, leaseToken: body.leaseToken, attempts: 1 }],
            });
          confirmed++;
          return Response.json({ updated: true });
        },
        send: async () => {
          sent++;
        },
      },
      dispatch({
        fetch: async () => {
          assert.fail("failed pending must not wake");
        },
      }),
      (entry) => {
        logs.push(entry);
      },
    ),
    /feed_cleanup/,
  );
  assert.equal(sent, 1);
  assert.equal(confirmed, 1);
  assert.equal(
    logs.some((v) => v.event === "feed_source_relay" && v.delivered === 1),
    true,
  );
  assert.equal(
    logs.some((v) => v.event === "feed_cleanup_failed"),
    true,
  );
});
test("cleanup outbound permits only executor-authenticated discrete commands", async () => {
  let calls = 0;
  const bindings = {
    ...env,
    FEED_ADAPTER: {
      fetch: async () => {
        calls++;
        return Response.json({ ok: true });
      },
    },
  };
  const request = (operation: string, secret = env.FEED_EXECUTOR_SECRET) =>
    new Request(
      `http://feed-cleanup.internal/internal/feed/cleanup/v1/${operation}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "x-feed-contract": "1" },
        body: "{}",
      },
    );
  for (const operation of ["claim", "step", "fail", "release"])
    assert.equal(
      (await deletionCleanup(request(operation), bindings)).status,
      200,
    );
  for (const operation of [
    "pending",
    "status",
    "replay",
    "claim?other=1",
    "sql",
  ])
    assert.equal(
      (await deletionCleanup(request(operation), bindings)).status,
      401,
    );
  assert.equal(
    (await deletionCleanup(request("claim", env.FEED_BRIDGE_SECRET), bindings))
      .status,
    401,
  );
  assert.equal(calls, 4);
});

function operatorRequest(
  operation = "status",
  changes: Record<string, string> = {},
  body: unknown = { kind: "deletion", id: "del:1" },
) {
  return new Request(
    `https://runtime/internal/runtime/feed-admin/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}`,
        "x-feed-operator": "x".repeat(32),
        "x-feed-contract": "1",
        "x-feed-target": "staging",
        "x-feed-release": env.FEED_RELEASE_SHA,
        "x-feed-writer-epoch": "1",
        ...changes,
      },
      body: JSON.stringify(body),
    },
  );
}
test("operator proxy needs both credentials, current target context and an exact capability", async () => {
  let calls = 0;
  const bindings = {
    ...env,
    FEED_ADAPTER: {
      fetch: async (request: Request) => {
        calls++;
        assert.equal(
          new URL(request.url).pathname,
          "/internal/feed/admin/v1/status",
        );
        assert.equal(
          request.headers.get("authorization"),
          `Bearer ${"x".repeat(32)}`,
        );
        assert.equal(request.headers.get("x-feed-operator"), null);
        assert.equal(request.headers.get("x-feed-release"), null);
        return Response.json({ job: null });
      },
    },
  };
  assert.equal(
    (await handleAdminRequest(operatorRequest(), bindings)).status,
    200,
  );
  assert.equal(
    (
      await handleAdminRequest(
        operatorRequest("status", { authorization: "Bearer wrong" }),
        bindings,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleAdminRequest(
        operatorRequest("status", { "x-feed-operator": "" }),
        bindings,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleAdminRequest(
        operatorRequest("status", { "x-feed-release": "b".repeat(40) }),
        bindings,
      )
    ).status,
    409,
  );
  assert.equal(
    (await handleAdminRequest(operatorRequest("sql"), bindings)).status,
    404,
  );
  assert.equal(
    (
      await handleAdminRequest(operatorRequest(), {
        ...bindings,
        FEED_ENVIRONMENT: "production",
      })
    ).status,
    503,
  );
  assert.equal(calls, 1);
});
test("operator replay rejects arbitrary fields and stale epochs before an adapter mutation", async () => {
  const bindings = {
    ...env,
    FEED_ADAPTER: {
      fetch: async () => {
        assert.fail("invalid command must not forward");
      },
    },
  };
  const command = {
    kind: "sourceEvent",
    id: "event:1",
    writerEpoch: 1,
    commandId: "12345678-1234-4234-8234-123456789012",
    operator: "octocat",
    reason: "Retry after source recovery",
  };
  for (const body of [
    { ...command, writerEpoch: 2 },
    { ...command, sql: "select 1" },
    { ...command, commandId: "bad" },
    { ...command, reason: "short" },
  ])
    assert.equal(
      (await handleAdminRequest(operatorRequest("replay", {}, body), bindings))
        .status,
      400,
    );
});

test("core source operator command uses a strict positive sequence and never acquires a Feed epoch", async () => {
  let forwards = 0;
  const bindings = {
    ...env,
    FEED_ADAPTER: {
      fetch: async (request: Request) => {
        forwards++;
        const body = (await request.json()) as Record<string, unknown>;
        assert.equal(body.writerEpoch, undefined);
        assert.equal(body.kind, "coreSource");
        return Response.json({ ok: true });
      },
    },
  };
  const body = {
    kind: "coreSource",
    id: "42",
    commandId: "12345678-1234-4234-8234-123456789012",
    operator: "octocat",
    reason: "Core source failure resolved",
  };
  const call = (value: unknown) =>
    handleAdminRequest(
      new Request("https://runtime/internal/runtime/feed-admin/v1/replay", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}`,
          "x-feed-operator": "x".repeat(32),
          "x-feed-contract": "1",
          "x-feed-target": "staging",
          "x-feed-release": env.FEED_RELEASE_SHA,
          "x-feed-writer-epoch": "1",
        },
        body: JSON.stringify(value),
      }),
      bindings,
    );
  assert.equal((await call(body)).status, 200);
  for (const bad of [
    { ...body, id: "01" },
    { ...body, id: "9007199254740992" },
    { ...body, writerEpoch: 1 },
  ])
    assert.equal((await call(bad)).status, 400);
  assert.equal(forwards, 1);
});


test("container storage transports reject cross-role capabilities before binding access", async () => {
  let calls = 0;
  const bindings = { ...env, FEED_ADAPTER: { fetch: async () => { calls++; return Response.json({ ok: true }); } } };
  const request = (operation: string) => new Request(`http://feed-bindings.internal/internal/feed/v1/${operation}`, {
    method: "POST", headers: { authorization: `Bearer ${env.FEED_BRIDGE_SECRET}`, "x-feed-contract": "1" }, body: "{}",
  });
  for (const op of ["jobs.claim", "jobs.complete", "jobs.fail", "projection.apply"]) {
    assert.equal((await bindingBridge(request(op), bindings)).status, 401);
    assert.equal((await executorBindingBridge(request(op), bindings)).status, 200);
  }
  for (const op of ["users.ensure", "preferences.replace", "events.append", "sessions.put", "profile.delete"]) {
    assert.equal((await executorBindingBridge(request(op), bindings)).status, 401);
    assert.equal((await bindingBridge(request(op), bindings)).status, 200);
  }
  for (const bridge of [bindingBridge, executorBindingBridge]) {
    assert.equal((await bridge(request("health"), bindings)).status, 200);
    assert.equal((await bridge(request("sql.execute"), bindings)).status, 401);
    assert.equal((await bridge(request("taxonomy.approve"), bindings)).status, 401);
  }
  assert.equal(calls, 11);
});
