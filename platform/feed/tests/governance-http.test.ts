import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
const operator = "local-test-only-operator-key-32-characters-minimum";
async function call(
  operation = "proposal",
  raw: unknown = { proposalKind: "assessment", proposalId: "missing-proposal" },
  token = operator,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch(
    `https://adapter/internal/feed/governance/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-feed-contract": "1",
        ...headers,
      },
      body: JSON.stringify(raw),
    },
  );
}
it("operator-only governance reaches real D1 and preserves strict no-store contracts", async () => {
  const response = await call();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-feed-contract")).toBe("1");
  expect(await response.json()).toEqual({ proposal: null });
  for (const token of [
    "local-test-only-bridge-key-32-characters-minimum",
    "local-test-only-executor-key-32-characters-minimum",
    "local-source-test-key-separate-32-characters-minimum",
    "",
  ])
    expect((await call("proposal", {}, token)).status).toBe(401);
  expect(
    (
      await call("proposal", {
        proposalKind: "assessment",
        proposalId: "missing",
        sql: "SELECT 1",
      })
    ).status,
  ).toBe(400);
  expect(
    (await call("proposal", {}, operator, { "x-feed-contract": "2" })).status,
  ).toBe(409);
  expect((await call("proposal?sql=1")).status).toBe(404);
  expect((await call("sql")).status).toBe(404);
  expect((await call("review", { padding: "x".repeat(32768) })).status).toBe(
    413,
  );
});
