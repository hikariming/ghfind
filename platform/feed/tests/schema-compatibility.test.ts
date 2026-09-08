import { env, exports } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";

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
afterEach(async () => {
  await env.FEED_DB.exec(
    "INSERT INTO feed_schema_compatibility VALUES(1,1,1,2,2) ON CONFLICT(id) DO UPDATE SET min_reader_contract=1,max_reader_contract=1,min_writer_contract=2,max_writer_contract=2",
  );
});
it("honors explicit reader/writer compatibility across additive schema versions", async () => {
  expect((await health()).ready).toBe(true);
  await env.FEED_DB.exec(
    "UPDATE feed_runtime_control SET schema_version=8 WHERE id=1",
  );
  expect((await health()).ready).toBe(true);
  expect((await health(true)).ready).toBe(true);
  await env.FEED_DB.exec(
    "UPDATE feed_schema_compatibility SET min_writer_contract=3,max_writer_contract=3 WHERE id=1",
  );
  expect((await health()).ready).toBe(false);
  expect((await health(true)).ready).toBe(false);
  await env.FEED_DB.exec(
    "UPDATE feed_schema_compatibility SET min_writer_contract=2,max_writer_contract=2,min_reader_contract=2,max_reader_contract=2 WHERE id=1",
  );
  expect((await health()).ready).toBe(false);
  await env.FEED_DB.exec("DELETE FROM feed_schema_compatibility WHERE id=1");
  expect((await health()).ready).toBe(false);
});

it("does not report ready when the current privacy capability schema is missing", async () => {
  expect((await health()).ready).toBe(true);
  await env.FEED_DB.exec(
    "ALTER TABLE feed_project_tags RENAME COLUMN origin_proposal_id TO missing_origin_proposal_id",
  );
  expect((await health()).ready).toBe(false);
  expect((await health(true)).ready).toBe(false);
  await env.FEED_DB.exec(
    "ALTER TABLE feed_project_tags RENAME COLUMN missing_origin_proposal_id TO origin_proposal_id",
  );
  expect((await health()).ready).toBe(true);
  await env.FEED_DB.exec(
    "ALTER TABLE feed_governance_guards RENAME TO unavailable_governance_guards",
  );
  expect((await health()).ready).toBe(false);
  expect((await health(true)).ready).toBe(false);
  await env.FEED_DB.exec(
    "ALTER TABLE unavailable_governance_guards RENAME TO feed_governance_guards",
  );
});
