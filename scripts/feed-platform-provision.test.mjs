import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  definitions,
  planHash,
  plan,
  newReceipt,
  inspect,
  provision,
  authenticatedTransport,
} from "./feed-platform-provision.mjs";
function fake() {
  const resources = new Map(),
    calls = [];
  let sequence = 1;
  const request = async (operation) => {
    calls.push(operation);
    const d = definitions.find((d) =>
      operation.method === "POST"
        ? d.name === (operation.body.name || operation.body.queue_name)
        : operation.path.includes(d.name),
    );
    assert.ok(d, "only fixed resources are requested");
    if (operation.method === "POST") {
      const value =
        d.kind === "d1"
          ? {
              name: d.name,
              uuid: `${sequence++}2345678-1234-1234-1234-123456789012`,
            }
          : d.kind === "queue"
            ? { queue_name: d.name, queue_id: String(sequence++).repeat(32) }
            : { name: d.name };
      resources.set(d.name, value);
      return { status: 200, success: true, result: value };
    }
    const value = resources.get(d.name);
    if (d.kind === "r2")
      return value
        ? { status: 200, success: true, result: value }
        : { status: 404, success: false };
    return {
      status: 200,
      success: true,
      result: value ? [value] : [],
      result_info: { total_pages: 1 },
    };
  };
  return { resources, calls, request };
}
test("default is offline dry-run with exactly five fixed creates and no deletes", () => {
  const result = JSON.parse(
    execFileSync(process.execPath, ["scripts/feed-platform-provision.mjs"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    }),
  );
  assert.equal(result.mode, "dry-run");
  assert.equal(result.planHash, planHash);
  assert.equal(result.operations.length, 5);
  assert.equal(result.limits.deletes, 0);
  assert.deepEqual(result, plan());
});
test("creates sequentially, confirms identities, journals before writes and resumes without duplicates", async () => {
  const f = fake();
  let persisted;
  let receipts = 0;
  const receipt = await provision({
    reviewedPlanHash: planHash,
    request: async (op) => {
      if (op.method === "POST")
        assert.equal(
          persisted.pending.name,
          op.body.name || op.body.queue_name,
        );
      return f.request(op);
    },
    onReceipt: (r) => {
      persisted = r;
      receipts++;
    },
  });
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.resources.length, 5);
  assert.equal(receipts, 11);
  assert.equal(
    f.calls.slice(0, 5).every((c) => c.method === "GET"),
    true,
  );
  const posts = f.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 5);
  await provision({
    request: f.request,
    reviewedPlanHash: planHash,
    receipt,
    onReceipt: (r) => {
      persisted = r;
    },
  });
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 5);
});
test("unknown names, permission failures and unsafe IDs prevent all writes", async () => {
  for (const mode of ["collision", "forbidden", "permission"]) {
    const f = fake();
    f.resources.set(definitions[0].name, {
      name: definitions[0].name,
      uuid:
        mode === "forbidden"
          ? "60d45096-bfe7-4de1-8b85-c1b66a466b0d"
          : "12345678-1234-1234-1234-123456789012",
    });
    const request =
      mode === "permission"
        ? async (op) => {
            f.calls.push(op);
            return { status: 403, success: false };
          }
        : f.request;
    await assert.rejects(
      provision({ request, reviewedPlanHash: planHash, onReceipt: () => {} }),
    );
    assert.equal(
      f.calls.some((c) => c.method === "POST"),
      false,
    );
  }
});
test("uncertain creation preserves pending receipt and never retries or deletes", async () => {
  const f = fake();
  let receipt;
  await assert.rejects(
    provision({
      reviewedPlanHash: planHash,
      request: async (op) => {
        const response = await f.request(op);
        if (op.method === "POST")
          throw new Error("connection_lost_after_commit");
        return response;
      },
      onReceipt: (r) => {
        receipt = r;
      },
    }),
  );
  assert.equal(receipt.status, "uncertain");
  assert.equal(receipt.pending.name, definitions[0].name);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
  await assert.rejects(
    provision({
      reviewedPlanHash: planHash,
      request: f.request,
      receipt,
      onReceipt: () => {},
    }),
  );
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(
    (await inspect(f.request)).resources[0].existing.name,
    definitions[0].name,
  );
});
test("wrong plan, foreign account and added secret fields reject before network", async () => {
  for (const mutate of [
    (r) => (r.accountId = "foreign"),
    (r) => (r.token = "secret"),
    (r) => r.resources.push({ kind: "d1", name: "ghfind", id: "unsafe" }),
  ]) {
    const receipt = newReceipt();
    mutate(receipt);
    await assert.rejects(
      provision({
        reviewedPlanHash: planHash,
        receipt,
        request: async () => {
          assert.fail("no network");
        },
        onReceipt: () => {},
      }),
    );
  }
  await assert.rejects(
    provision({
      reviewedPlanHash: "wrong",
      request: async () => {
        assert.fail("no network");
      },
      onReceipt: () => {},
    }),
  );
});

test("authenticated transport rejects arbitrary SQL, production names and unplanned bodies before network", async () => {
  const request = authenticatedTransport("fixture-secret");
  for (const operation of [
    {
      method: "POST",
      path: "/d1/database/production/query",
      body: { sql: "DROP TABLE users" },
    },
    { method: "DELETE", path: "/d1/database/id" },
    { method: "POST", path: "/d1/database", body: { name: "ghfind" } },
    {
      method: "POST",
      path: "/d1/database",
      body: { name: definitions[0].name, unexpected: "value" },
    },
    { method: "GET", path: "/queues?name=production" },
  ])
    await assert.rejects(request(operation), /forbidden_provision_operation/);
});
