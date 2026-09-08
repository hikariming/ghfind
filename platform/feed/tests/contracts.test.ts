/* eslint-disable @typescript-eslint/no-explicit-any -- Deliberately inspect arbitrary wire responses in contract tests. */
import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedArchive } from "../src/archive";

const fence = { writerEpoch: 1, expectedProfileVersion: 1 };
async function call(
  operation: string,
  payload: unknown,
  secret = "local-test-only-bridge-key-32-characters-minimum",
) {
  return exports.default.fetch(
    `https://feed-data.internal/internal/feed/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "x-feed-contract": "1",
      },
      body: JSON.stringify(payload),
    },
  );
}
async function json(operation: string, payload: unknown) {
  const response = await call(operation, payload);
  const result = await response.json<Record<string, any>>();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}
async function ensure(githubId = 1) {
  return json("users.ensure", {
    ...fence,
    expectedProfileVersion: 0,
    githubId,
    login: `actor-${githubId}`,
    avatarUrl: "",
  });
}
async function seed(count = 1, evidence = true) {
  const now = Date.now();
  const rows = Array.from({ length: count }, (_, i) => ({
    repo: `owner${i}/repo`,
    analysis: `analysis-${i}`,
  }));
  for (let i = 0; i < rows.length; i += 40) {
    await env.FEED_DB.batch(
      rows
        .slice(i, i + 40)
        .flatMap((row, index) => [
          env.FEED_DB.prepare(
            `INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,topics_json,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,treasure_eligible,analyzed_at,risks_json,published,source_hash,projected_at) VALUES(?,?,?,?,?,?,'[]','micro-tool','active-evolution',80,90,'verified','low',1,?,'{}',1,'hash',?)`,
          ).bind(
            row.repo,
            row.analysis,
            row.repo.split("/")[0],
            "repo",
            `https://github.com/${row.repo}`,
            "approved summary",
            now - index,
            now,
          ),
          env.FEED_DB.prepare(
            "INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at) VALUES(?,'artifact:micro-tool','assessment',1,1,?,1,?,?)",
          ).bind(row.repo, row.analysis, now, now),
          ...(evidence
            ? [
                env.FEED_DB.prepare(
                  "INSERT INTO feed_submission_provenance(repo_key,analysis_id,source_event_id,source_version,evidence_kind,evidence_ref,submitted_at) VALUES(?,?,?,1,'user_submission','receipt-test',?)",
                ).bind(row.repo, row.analysis, `event-${row.repo}`, now),
              ]
            : []),
        ]),
    );
  }
}
async function request(githubId = 1, profileVersion = 1, id = "request-1") {
  const candidates = await json("candidates.load", { githubId, limit: 240 });
  const item = {
    project: candidates.candidates[0].project,
    candidateSources: ["latest"],
    reasonCodes: ["recent_project"],
    score: 0.735,
    rank: 1,
    exploration: false,
    propensity: 0.952,
    features: {
      productScore: 0.8,
      confidence: 0.9,
      freshness: 0.95,
      discoveryBoost: 1,
      mmrScore: 0.7,
    },
  };
  const user = (await json("users.get", { githubId })).user;
  const payload = {
    ...fence,
    expectedProfileVersion: profileVersion,
    payloadHash: "a".repeat(64),
    id,
    user,
    seed: "seed",
    candidateCounts: { latest: 1 },
    degraded: [],
    durationMs: 12,
    items: [item],
  };
  await json("requests.save", payload);
  return { item, payload };
}
beforeEach(async () => {
  const names = [
    "feed_command_guards",
    "feed_submission_provenance",
    "feed_runtime_sessions",
    "feed_runtime_requests",
    "feed_runtime_served_metadata",
    "feed_runtime_events",
    "feed_behavior_signals",
    "feed_runtime_outbox",
    "feed_profile_deletions",
    "feed_profile_floors",
    "feed_served_items",
    "feed_events",
    "feed_user_project_states",
    "feed_user_tag_preferences",
    "feed_users",
    "feed_project_tags",
    "feed_project_moderation",
    "feed_projects",
  ];
  await env.FEED_DB.batch(
    names.map((name) => env.FEED_DB.prepare(`DELETE FROM ${name}`)),
  );
  await env.FEED_DB.prepare(
    "UPDATE feed_runtime_control SET writer_epoch=1,writes_enabled=1",
  ).run();
});

describe("real workerd D1 capability contract", () => {
  it("requires independent secret, version, strict fields, and bounds streamed input", async () => {
    expect((await call("health", {}, "wrong")).status).toBe(401);
    expect(
      (await call("users.get", { githubId: 1, ip: "private" })).status,
    ).toBe(400);
    const response = await exports.default.fetch(
      "https://feed-data.internal/internal/feed/v1/health",
      {
        method: "POST",
        headers: {
          authorization:
            "Bearer local-test-only-bridge-key-32-characters-minimum",
          "x-feed-contract": "1",
          "content-type": "application/json",
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(" ".repeat(128 * 1024 + 1)),
            );
            controller.close();
          },
        }),
      },
    );
    expect(response.status).toBe(413);
    expect(await json("health", {})).toEqual({
      ready: true,
      contractVersion: "1",
      writerEpoch: 1,
      writesEnabled: true,
    });
  });
  it("reapplies additive migration and preserves legacy taxonomy", async () => {
    await applyD1Migrations(env.FEED_DB, env.TEST_MIGRATIONS);
    const migration = env.TEST_MIGRATIONS.find((m) =>
      m.name.startsWith("0003"),
    )!;
    await env.FEED_DB.batch(
      migration.queries.map((query) => env.FEED_DB.prepare(query)),
    );
    expect((await json("taxonomy.list", {})).tags).toHaveLength(13);
  });
  it("quarantines assessed projects without submission evidence", async () => {
    await ensure();
    await seed(1, false);
    expect(
      (await json("candidates.load", { githubId: 1, limit: 240 })).candidates,
    ).toEqual([]);
    expect(
      (
        await json("projects.available", {
          githubId: 1,
          repoKeys: ["owner0/repo"],
        })
      ).available,
    ).toEqual({});
  });
  it("caps each recall and accepts 240 keys without excessive SQL parameters", async () => {
    await ensure();
    await seed(245);
    await json("preferences.replace", {
      ...fence,
      githubId: 1,
      taxonomyVersion: 1,
      preferences: [
        {
          tagId: "artifact:micro-tool",
          value: 1,
          source: "explicit",
          strength: 1,
          taxonomyVersion: 1,
        },
      ],
    });
    const result = await json("candidates.load", { githubId: 1, limit: 240 });
    expect(result.counts).toEqual({
      tag: 80,
      latest: 40,
      quality: 20,
      discovery: 20,
    });
    expect(result.candidates.length).toBeLessThanOrEqual(160);
    const keys = Array.from({ length: 240 }, (_, i) => `owner${i}/repo`);
    expect(
      Object.keys(
        (await json("projects.available", { githubId: 1, repoKeys: keys }))
          .available,
      ),
    ).toHaveLength(240);
  });
  it("rolls back stale epochs, invalid tags, and concurrent profile writes", async () => {
    await ensure();
    const payload = {
      ...fence,
      githubId: 1,
      taxonomyVersion: 1,
      preferences: [
        {
          tagId: "artifact:micro-tool",
          value: 1,
          source: "explicit",
          strength: 1,
          taxonomyVersion: 1,
        },
      ],
    };
    expect(
      (await call("preferences.replace", { ...payload, writerEpoch: 2 }))
        .status,
    ).toBe(409);
    expect(
      (
        await call("preferences.replace", {
          ...payload,
          preferences: [{ ...payload.preferences[0], tagId: "unknown" }],
        })
      ).status,
    ).toBe(404);
    expect((await json("users.get", { githubId: 1 })).user.profileVersion).toBe(
      1,
    );
    const results = await Promise.all([
      call("preferences.replace", payload),
      call("preferences.replace", payload),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await json("users.get", { githubId: 1 })).user.profileVersion).toBe(
      2,
    );
    expect(
      (await env.FEED_DB.prepare(
        "SELECT COUNT(*) AS n FROM feed_command_guards",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it("persists exact request retries and rejects attribution collisions", async () => {
    await ensure();
    await seed();
    const { payload } = await request();
    await json("requests.save", payload);
    expect(
      (await call("requests.save", { ...payload, payloadHash: "b".repeat(64) }))
        .status,
    ).toBe(409);
    const stored = await env.FEED_DB.prepare(
      "SELECT propensity FROM feed_served_items",
    ).first<{ propensity: number }>();
    expect(stored!.propensity).toBe(0.952);
  });
  it("keeps private session attribution and ignores impression arrival between pages", async () => {
    await ensure();
    await ensure(2);
    await seed();
    const { item } = await request();
    const now = Date.now(),
      session = {
        id: "session-one",
        githubId: 1,
        algorithmVersion: "baseline-v1",
        taxonomyVersion: 1,
        profileVersion: 1,
        pageSize: 20,
        seed: "seed",
        candidateCounts: { latest: 1 },
        degraded: [],
        items: [item],
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1800000).toISOString(),
      };
    await json("sessions.put", { ...fence, session });
    const event = {
      input: {
        id: "impression-1",
        type: "impression",
        repoKey: "owner0/repo",
        occurredAt: new Date().toISOString(),
        impressionToken: "signed-by-api",
      },
      requestId: "request-1",
      metadata: { rank: 1, algorithmVersion: "baseline-v1" },
    };
    expect(
      await json("events.append", { ...fence, githubId: 1, events: [event] }),
    ).toEqual({ accepted: 1, duplicate: 0 });
    expect(
      await json("events.append", { ...fence, githubId: 1, events: [event] }),
    ).toEqual({ accepted: 0, duplicate: 1 });
    expect(
      (await json("sessions.get", { ...fence, githubId: 1, id: "session-one" }))
        .session.items[0],
    ).toEqual(item);
    expect(
      (await call("sessions.get", { ...fence, githubId: 2, id: "session-one" }))
        .status,
    ).toBe(404);
    expect(
      (
        await json("projects.available", {
          githubId: 1,
          repoKeys: ["owner0/repo"],
        })
      ).available["owner0/repo"],
    ).toBe(true);
  });
  it("materializes qualified behavior while explicit preference wins", async () => {
    await ensure();
    await seed();
    await request();
    const event = {
      input: {
        id: "detail",
        type: "detail_open",
        repoKey: "owner0/repo",
        occurredAt: new Date().toISOString(),
        impressionToken: "signed",
      },
      requestId: "request-1",
      metadata: { rank: 1, algorithmVersion: "baseline-v1" },
    };
    await json("events.append", { ...fence, githubId: 1, events: [event] });
    expect((await json("users.get", { githubId: 1 })).user.preferences).toEqual(
      [],
    );
    await json("events.append", {
      ...fence,
      githubId: 1,
      events: [
        {
          ...event,
          input: { ...event.input, id: "outbound", type: "github_outbound" },
        },
      ],
    });
    expect(
      (await json("users.get", { githubId: 1 })).user.preferences[0].source,
    ).toBe("behavior");
    await json("preferences.replace", {
      ...fence,
      expectedProfileVersion: 2,
      githubId: 1,
      taxonomyVersion: 1,
      preferences: [
        {
          tagId: "artifact:micro-tool",
          value: -1,
          source: "explicit",
          strength: 1,
          taxonomyVersion: 1,
        },
      ],
    });
    expect(
      (await json("users.get", { githubId: 1 })).user.preferences[0],
    ).toMatchObject({ source: "explicit", value: -1 });
    expect(
      (
        await json("projects.available", {
          githubId: 1,
          repoKeys: ["owner0/repo"],
        })
      ).available,
    ).toEqual({});
  });
  it("fences deletion and prevents stale writes after recreation", async () => {
    await ensure();
    await seed();
    await request();
    const deletion = await json("profile.delete", {
      ...fence,
      githubId: 1,
      now: new Date().toISOString(),
    });
    expect(deletion.status).toBe("pending");
    expect(
      (
        await json("profile.deletion.get", {
          githubId: 1,
          deletionId: deletion.deletionId,
        })
      ).status,
    ).toBe("pending");
    expect(
      (
        await call("profile.deletion.get", {
          githubId: 2,
          deletionId: deletion.deletionId,
        })
      ).status,
    ).toBe(404);
    await ensure();
    expect((await json("users.get", { githubId: 1 })).user.profileVersion).toBe(
      2,
    );
    expect(
      (
        await call("state.set", {
          ...fence,
          githubId: 1,
          repoKey: "owner0/repo",
          requestId: "request-1",
          saved: true,
          now: new Date().toISOString(),
        })
      ).status,
    ).toBe(409);
  });
  it("archives via R2 binding and deletes only the requested generation", async () => {
    const archive = new FeedArchive(env.FEED_ARCHIVE);
    await archive.put(1, 1, "event", new TextEncoder().encode("{}"));
    await archive.put(1, 2, "event", new TextEncoder().encode("{}"));
    expect((await archive.deleteBatch(1, 1)).complete).toBe(true);
    expect(await archive.get(1, 1, "event")).toBeNull();
    expect(await archive.get(1, 2, "event")).not.toBeNull();
  });
});
