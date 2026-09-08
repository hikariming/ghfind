import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

const health = async (archive = false) => {
  const response = await exports.default.fetch(
    `https://feed.internal/internal/feed/${archive ? "archive/v1" : "v1"}/health`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feed-contract": "1",
        authorization: `Bearer ${archive ? "local-test-only-executor-key-32-characters-minimum" : "local-test-only-bridge-key-32-characters-minimum"}`,
      },
      body: "{}",
    },
  );
  return response.json<{ ready: boolean }>();
};
it("honors explicit reader/writer compatibility across additive schema versions", async () => {
  expect((await health()).ready).toBe(true);
  await env.FEED_DB.exec(
    "UPDATE feed_runtime_control SET schema_version=8 WHERE id=1",
  );
  expect((await health()).ready).toBe(true);
  expect((await health(true)).ready).toBe(true);
  await env.FEED_DB.exec(
    "UPDATE feed_schema_compatibility SET min_writer_contract=2,max_writer_contract=2 WHERE id=1",
  );
  expect((await health()).ready).toBe(false);
  expect((await health(true)).ready).toBe(false);
  await env.FEED_DB.exec(
    "UPDATE feed_schema_compatibility SET min_writer_contract=1,max_writer_contract=1,min_reader_contract=2,max_reader_contract=2 WHERE id=1",
  );
  expect((await health()).ready).toBe(false);
  await env.FEED_DB.exec("DELETE FROM feed_schema_compatibility WHERE id=1");
  expect((await health()).ready).toBe(false);
});
