import { Buffer } from "node:buffer";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const executor = "local-test-only-executor-key-32-characters-minimum";
const bridge = "local-test-only-bridge-key-32-characters-minimum";
const request = (path: string, input: unknown, secret = executor) =>
  exports.default.fetch(`https://feed.internal/internal/feed/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-feed-contract": "1",
    },
    body: JSON.stringify(input),
  });

describe("executor-only archive HTTP capability", () => {
  it("rejects alternate roles, unknown fields, arbitrary keys and invalid base64/JSON", async () => {
    expect((await request("archive/v1/health", {}, bridge)).status).toBe(401);
    expect((await request("archive/v1/health", {})).status).toBe(200);
    expect(
      (
        await request("archive/v1/get", {
          writerEpoch: 1,
          githubId: 11,
          profileVersion: 1,
          archiveId: "../escape",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("archive/v1/health", { sql: "SELECT 1" })).status,
    ).toBe(400);
    expect((await request("archive/v1/health?other=true", {})).status).toBe(
      404,
    );
    const id = {
      writerEpoch: 1,
      githubId: 11,
      profileVersion: 1,
      archiveId: "events",
    };
    expect(
      (await request("archive/v1/put", { ...id, bodyBase64: "e30=\n" })).status,
    ).toBe(400);
    expect(
      (
        await request("archive/v1/put", {
          ...id,
          bodyBase64: Buffer.from("not JSON").toString("base64"),
        })
      ).status,
    ).toBe(400);
  });
  it("requires current generation for writes and registered matching content for reads", async () => {
    const githubId = 991001;
    const ensured = await request(
      "v1/users.ensure",
      {
        writerEpoch: 1,
        expectedProfileVersion: 0,
        githubId,
        login: "archive-wire",
        avatarUrl: "",
      },
      bridge,
    );
    expect(ensured.status).toBe(200);
    const { user } = await ensured.json<{ user: { profileVersion: number } }>();
    const id = {
      writerEpoch: 1,
      githubId,
      profileVersion: user.profileVersion,
      archiveId: "events",
    };
    const bodyBase64 = Buffer.from('{"events":[]}').toString("base64");
    const stored = await request("archive/v1/put", { ...id, bodyBase64 });
    expect(stored.status).toBe(200);
    const { key } = await stored.json<{ key: string }>();
    expect(await (await request("archive/v1/get", id)).json()).toEqual({
      bodyBase64,
    });
    expect(
      (await request("archive/v1/put", { ...id, writerEpoch: 99, bodyBase64 }))
        .status,
    ).toBe(409);
    await env.FEED_DB.prepare(
      "UPDATE feed_users SET profile_version=profile_version+1 WHERE github_id=?",
    )
      .bind(githubId)
      .run();
    expect(
      (
        await request("archive/v1/put", {
          ...id,
          archiveId: "stale",
          bodyBase64,
        })
      ).status,
    ).toBe(409);
    // A newer preference version does not erase previously committed archives.
    expect((await request("archive/v1/get", id)).status).toBe(200);
    await env.FEED_ARCHIVE.put(key, '{"tampered":true}');
    const corrupted = await request("archive/v1/get", id);
    expect(corrupted.status).toBe(409);
    expect(await corrupted.json()).toEqual({ error: "archive_id_conflict" });
    await env.FEED_ARCHIVE.put(
      `feed/v1/users/${githubId}/${user.profileVersion}/unregistered.json`,
      "{}",
    );
    expect(
      (await request("archive/v1/get", { ...id, archiveId: "unregistered" }))
        .status,
    ).toBe(404);
  });
});
