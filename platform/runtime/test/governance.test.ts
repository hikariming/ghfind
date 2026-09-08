import { test } from "node:test";
import { strict as assert } from "node:assert";
import { handleGovernanceRequest } from "../src/governance";
import type { RuntimeSettings } from "../src/router";

const env: RuntimeSettings = {
  FEED_SOURCE_RELAY_ENABLED: "true",
  FEED_QUEUE_NAME: "ghfind-feed-staging-jobs",
  FEED_DLQ_NAME: "ghfind-feed-staging-dlq",
  WORKER_VERSION: {
    id: "worker-version",
    tag: "test",
    timestamp: "2026-09-08T00:00:00Z",
  },
  FEED_ENVIRONMENT: "staging",
  FEED_RELEASE_SHA: "a".repeat(40),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${"b".repeat(64)}`,
  FEED_MODE: "baseline",
  FEED_WRITER_EPOCH: "1",
  FEED_EXECUTOR_ENABLED: "true",
  FEED_GATEWAY_SECRET: "g".repeat(32),
  FEED_SIGNING_SECRET: "s".repeat(32),
  FEED_BRIDGE_SECRET: "b".repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: "r".repeat(32),
  FEED_EXECUTOR_SECRET: "e".repeat(32),
  FEED_SOURCE_SECRET: "q".repeat(32),
  FEED_DELIVERY_SECRET: "d".repeat(32),
};
function request(
  operation = "proposal",
  body: unknown = { proposalKind: "assessment", proposalId: "proposal-1" },
  headers: Record<string, string> = {},
) {
  return new Request(
    `https://runtime/internal/runtime/feed-governance/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}`,
        "x-feed-operator": "o".repeat(32),
        "x-feed-target": "staging",
        "x-feed-contract": "1",
        "x-feed-release": env.FEED_RELEASE_SHA,
        "x-feed-writer-epoch": "1",
        "content-type": "application/json",
        cookie: "client-cookie",
        "x-user-id": "forged",
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}
test("governance uses an operator-only bounded private capability and strips unrelated headers", async () => {
  let calls = 0;
  const bindings = {
    ...env,
    FEED_ADAPTER: {
      fetch: async (req: Request) => {
        calls++;
        assert.equal(
          req.url,
          "http://feed-adapter/internal/feed/governance/v1/proposal",
        );
        assert.equal(
          req.headers.get("authorization"),
          `Bearer ${"o".repeat(32)}`,
        );
        assert.equal(req.headers.get("cookie"), null);
        assert.equal(req.headers.get("x-user-id"), null);
        assert.deepEqual(await req.json(), {
          proposalKind: "assessment",
          proposalId: "proposal-1",
        });
        return Response.json(
          { proposal: null },
          { headers: { "set-cookie": "must-not-forward" } },
        );
      },
    },
  };
  const response = await handleGovernanceRequest(request(), bindings);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls, 1);
  for (const [req, code] of [
    [
      request(
        "proposal",
        {},
        { authorization: `Bearer ${env.FEED_GATEWAY_SECRET}` },
      ),
      401,
    ],
    [request("proposal", {}, { "x-feed-operator": "" }), 401],
    [
      request(
        "proposal",
        {},
        { "x-feed-operator": env.FEED_RUNTIME_ADMIN_SECRET },
      ),
      401,
    ],
    [request("proposal", {}, { "x-feed-release": "c".repeat(40) }), 409],
    [request("proposal", {}, { "x-feed-contract": "2" }), 409],
    [request("sql"), 404],
    [request("proposal?ignored=1"), 404],
    [request("review", { writerEpoch: 2 }), 409],
    [request("proposal", {}, { "content-type": "text/plain" }), 415],
    [request("proposal", { evidence: "x".repeat(32768) }), 413],
  ] as const)
    assert.equal((await handleGovernanceRequest(req, bindings)).status, code);
  assert.equal(
    (
      await handleGovernanceRequest(request(), {
        ...bindings,
        FEED_ENVIRONMENT: "production",
      })
    ).status,
    503,
  );
  assert.equal(calls, 1);
});
test("governance rejects invalid UTF-8 and oversized adapter responses without exposing content", async () => {
  let calls = 0;
  const bindings = {
    ...env,
    FEED_ADAPTER: {
      fetch: async () => {
        calls++;
        return new Response("x".repeat(65537));
      },
    },
  };
  const valid = request();
  const invalid = new Request(valid.url, {
    method: "POST",
    headers: valid.headers,
    body: new Uint8Array([0xff]),
  });
  assert.equal((await handleGovernanceRequest(invalid, bindings)).status, 400);
  assert.equal(calls, 0);
  assert.equal(
    (await handleGovernanceRequest(request(), bindings)).status,
    413,
  );
  assert.equal(calls, 1);
});
test("a legal escaped proposal evidence response fits the distinct response budget", async () => {
  const payload = {
    proposal: {
      proposalKind: "assessment",
      proposalId: "proposal-1",
      evidence: Array.from({ length: 64 }, () => "\\".repeat(256)),
      reviewReason: "r".repeat(500),
    },
  };
  assert.ok(new TextEncoder().encode(JSON.stringify(payload)).length > 32768);
  const response = await handleGovernanceRequest(request(), {
    ...env,
    FEED_ADAPTER: { fetch: async () => Response.json(payload) },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
});
