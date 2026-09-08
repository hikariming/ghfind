import { test } from "node:test";
import { strict as assert } from "node:assert";
import { template } from "./feed-platform-manifest.mjs";
import { verifyResources } from "./feed-platform-verify-resources.mjs";
function fixture() {
  const manifest = template();
  manifest.coreDatabase.id = "12345678-1234-1234-1234-123456789012";
  manifest.feedDatabase.id = "22345678-1234-1234-1234-123456789012";
  manifest.billing = {
    confirmed: true,
    evidence: "https://example.com/billing",
    maximumMonthlyUSD: 100,
    projectedMonthlyUSD: 79,
  };
  manifest.isolation = {
    reviewed: true,
    evidence: "https://example.com/isolation",
  };
  manifest.executorImplemented = true;
  const parking = {
    queue_id: "a".repeat(32),
    queue_name: manifest.terminalParkingQueue,
    settings: { message_retention_period: 1209600 },
    consumers: [],
  };
  const calls = [];
  return {
    manifest,
    parking,
    calls,
    fetcher: async (url, init) => {
      calls.push(url);
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, "Bearer fixture");
      const parsed = new URL(url);
      let result;
      if (parsed.pathname.endsWith(manifest.coreDatabase.id))
        result = { name: manifest.coreDatabase.name };
      else if (parsed.pathname.endsWith(manifest.feedDatabase.id))
        result = { name: manifest.feedDatabase.name };
      else if (parsed.pathname.includes("/r2/buckets/"))
        result = { name: manifest.archiveBucket };
      else if (parsed.searchParams.has("name"))
        result = [
          {
            queue_id: "a".repeat(32),
            queue_name: parsed.searchParams.get("name"),
          },
        ];
      else result = parking;
      return Response.json({ success: true, result });
    },
  };
}
test("deployment resource preflight reads actual parking retention and empty consumer state", async () => {
  const f = fixture();
  const result = await verifyResources(f.manifest, {
    token: "fixture",
    fetcher: f.fetcher,
  });
  assert.equal(result.retentionSeconds, 1209600);
  assert.equal(f.calls.length, 7);
  assert.equal(f.calls.at(-1).endsWith("/queues/" + "a".repeat(32)), true);
});
test("unreadable or short parking retention, a consumer, or wrong identity blocks release", async () => {
  for (const kind of ["retention", "missing", "consumer", "identity"]) {
    const f = fixture();
    if (kind === "retention")
      f.parking.settings.message_retention_period = 345600;
    if (kind === "missing") delete f.parking.consumers;
    if (kind === "consumer") f.parking.consumers = [{ type: "worker" }];
    if (kind === "identity") f.parking.queue_name = "production";
    await assert.rejects(
      verifyResources(f.manifest, { token: "fixture", fetcher: f.fetcher }),
      /Terminal parking/,
    );
  }
  const f = fixture();
  await assert.rejects(
    verifyResources(f.manifest, {
      token: "fixture",
      fetcher: async () => new Response(null, { status: 403 }),
    }),
    /403/,
  );
});
