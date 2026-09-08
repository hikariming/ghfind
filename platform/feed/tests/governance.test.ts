import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import {
  FeedGovernance,
  governanceSchemas,
  handleGovernance,
  type GovernanceReview,
} from "../src/governance";
import { FeedCommands } from "../src/commands";
import { hash, schemas, type Input } from "../src/contract";
import digestFixture from "../../../docs/contracts/fixtures/feed-governance-v1-digest.json";

const db = env.FEED_DB;
const governance = new FeedGovernance(db);
const commands = new FeedCommands(db);
const common = () => ({
  commandId: crypto.randomUUID(),
  writerEpoch: 1,
  expectedTaxonomyVersion: 1,
  operator: "synthetic-reviewer",
  reason: "Individually reviewed synthetic evidence",
});
const create = (proposalId = "gov-assessment-one"): GovernanceReview => ({
  ...common(),
  action: "create",
  proposalKind: "assessment",
  proposalId,
  expectedAnalysisId: "gov-analysis-one",
  labels: {
    labelZh: "治理工具",
    labelEn: "Governed tooling",
    description: "Synthetic review fixture",
  },
  assignment: { weight: 0.4, confidence: 0.8 },
});
async function proposal(
  kind: "assessment" | "user",
  id: string,
  repo = "gov-owner/one",
  analysis = "gov-analysis-one",
  namespace = "use_case",
  slug = "gov-new",
) {
  const table =
    kind === "assessment" ? "feed_tag_proposals" : "feed_user_tag_proposals";
  await db
    .prepare(
      `INSERT INTO ${table}(id,repo_key,analysis_id,namespace,slug,label_zh,label_en,evidence_json,status,created_at,updated_at) VALUES(?,?,?,?,?,'原始证据','Original evidence','["E1","E2"]','proposed',0,0)`,
    )
    .bind(id, repo, analysis, namespace, slug)
    .run();
}
beforeEach(async () => {
  await db.batch([
    ...[
      "feed_governance_commands",
      "feed_governance_guards",
      "feed_runtime_sessions",
      "feed_runtime_requests",
      "feed_served_items",
      "feed_runtime_served_metadata",
      "feed_runtime_events",
      "feed_events",
      "feed_behavior_signals",
      "feed_runtime_outbox",
      "feed_project_tags",
      "feed_submission_provenance",
      "feed_project_source_versions",
      "feed_project_moderation",
      "feed_projects",
      "feed_user_tag_preferences",
      "feed_user_project_states",
      "feed_users",
      "feed_profile_floors",
      "feed_tag_proposals",
      "feed_user_tag_proposals",
      "feed_tag_aliases",
    ].map((name) => db.prepare(`DELETE FROM ${name}`)),
    db.prepare("DELETE FROM feed_tag_definitions WHERE slug LIKE 'gov-%'"),
    db.prepare(
      "UPDATE feed_tag_definitions SET status='canonical',taxonomy_version=1 WHERE id IN ('artifact:micro-tool','artifact:web-app')",
    ),
    db.prepare("UPDATE feed_taxonomy_versions SET status='retired'"),
    db.prepare("DELETE FROM feed_taxonomy_versions WHERE version<>1"),
    db.prepare(
      "UPDATE feed_taxonomy_versions SET status='active' WHERE version=1",
    ),
    db.prepare(
      "UPDATE feed_runtime_control SET writer_epoch=1,writes_enabled=1",
    ),
  ]);
  for (const suffix of ["one", "two"])
    await db.batch([
      db
        .prepare(
          "INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,analyzed_at,risks_json,published,source_hash,projected_at) VALUES(?,?,'gov-owner',?,'https://github.com/gov-owner/'||?,'SYNTHETIC governance fixture','micro-tool','feature-complete',80,90,'verified','low',0,'[]',1,'synthetic',0)",
        )
        .bind(`gov-owner/${suffix}`, `gov-analysis-${suffix}`, suffix, suffix),
      db
        .prepare(
          "INSERT INTO feed_submission_provenance(repo_key,analysis_id,source_event_id,source_version,evidence_kind,evidence_ref,submitted_at) VALUES(?,?,?,1,'verified_historical','SYNTHETIC governance evidence',0)",
        )
        .bind(
          `gov-owner/${suffix}`,
          `gov-analysis-${suffix}`,
          `gov-source-${suffix}`,
        ),
    ]);
  await proposal("assessment", "gov-assessment-one");
  await proposal(
    "assessment",
    "gov-assessment-two",
    "gov-owner/two",
    "gov-analysis-two",
  );
  await proposal("user", "gov-user-one");
});
const active = () =>
  db
    .prepare("SELECT version FROM feed_taxonomy_versions WHERE status='active'")
    .first<number>("version");

it("uses portable UUID and Unicode boundaries without inferring omitted assignments", async () => {
  for (const commandId of [
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "00000000-0000-9000-8000-000000000001",
    "00000000-0000-4000-0000-000000000001",
  ]) {
    for (const [operation, input] of [
      ["command", { commandId }],
      ["review", { ...create(), commandId }],
      [
        "deprecate",
        { ...common(), commandId, canonicalTagId: "artifact:micro-tool" },
      ],
    ] as const)
      await expect(
        handleGovernance(operation, input, db),
      ).rejects.toMatchObject({
        status: 400,
        code: "invalid_request",
      });
  }
  for (const version of [1, 4, 7, 8])
    expect(
      governanceSchemas.command.safeParse({
        commandId: `ABCDEFAB-ABCD-${version}000-ABCD-ABCDEFABCDEF`,
      }).success,
    ).toBe(true);
  for (const assignment of [
    null,
    { confidence: 1 },
    { weight: null, confidence: 1 },
    { weight: 0, confidence: null },
  ])
    await expect(
      handleGovernance("review", { ...create(), assignment }, db),
    ).rejects.toMatchObject({ code: "invalid_request" });
  for (const invalid of [
    "Reviewed \ud800",
    "Reviewed \udc00",
    "Reviewed \ud800x",
    "Reviewed \udc00\ud800",
  ])
    expect(
      governanceSchemas.review.safeParse({ ...create(), reason: invalid })
        .success,
    ).toBe(false);
  expect(
    governanceSchemas.review.safeParse({
      ...create(),
      reason: "Reviewed 😀 中文",
    }).success,
  ).toBe(true);
  expect(
    governanceSchemas.review.safeParse({ ...create(), operator: "\ufeff" })
      .success,
  ).toBe(false);
  expect(
    governanceSchemas.review.safeParse({ ...create(), operator: "\u0085" })
      .success,
  ).toBe(true);
  for (const lexeme of ["1", "1.0", "1e0"])
    expect(
      governanceSchemas.review.safeParse({
        ...create(),
        writerEpoch: JSON.parse(lexeme),
      }).success,
    ).toBe(true);
  expect(await active()).toBe(1);
});

it.each([
  ["object", "{}"],
  ["null", "null"],
  ["non-string member", "[1]"],
  ["null member", "[null]"],
  ["too many items", JSON.stringify(Array(65).fill("E"))],
  ["too many UTF-8 bytes", JSON.stringify(["中".repeat(86)])],
  ["control", JSON.stringify(["bad\nvalue"])],
  ["DEL", JSON.stringify(["bad\u007fvalue"])],
  ["unpaired surrogate", '["\\ud800"]'],
])(
  "blocks %s stored evidence for inspection/promotion, retaining audited rejection",
  async (_label, encoded) => {
    for (const kind of ["assessment", "user"] as const) {
      const table =
        kind === "assessment"
          ? "feed_tag_proposals"
          : "feed_user_tag_proposals";
      const proposalId =
        kind === "assessment" ? "gov-assessment-one" : "gov-user-one";
      await db
        .prepare(
          `UPDATE ${table} SET namespace='artifact',evidence_json=? WHERE id=?`,
        )
        .bind(encoded, proposalId)
        .run();
      const input = { ...create(proposalId), proposalKind: kind };
      await expect(
        governance.proposal({ proposalKind: kind, proposalId }),
      ).rejects.toMatchObject({ code: "governance_evidence_invalid" });
      await expect(governance.review(input)).rejects.toMatchObject({
        code: "governance_evidence_invalid",
      });
      await expect(
        governance.review({
          ...common(),
          action: "map",
          proposalKind: kind,
          proposalId,
          expectedAnalysisId: input.expectedAnalysisId,
          canonicalTagId: "artifact:micro-tool",
          assignment: { weight: 1, confidence: 1 },
        }),
      ).rejects.toMatchObject({ code: "governance_evidence_invalid" });
      expect(await governance.command({ commandId: input.commandId })).toEqual({
        command: null,
      });
      const rejected: GovernanceReview = {
        ...common(),
        action: "reject",
        proposalKind: kind,
        proposalId,
        expectedAnalysisId: input.expectedAnalysisId,
      };
      const result = await governance.review(rejected);
      expect(result).toMatchObject({
        status: "rejected",
        canonicalTagId: null,
        taxonomyVersion: 1,
      });
      expect(await governance.review(rejected)).toEqual(result);
      expect(
        await db
          .prepare(
            "SELECT evidence_hash FROM feed_governance_commands WHERE command_id=?",
          )
          .bind(rejected.commandId)
          .first("evidence_hash"),
      ).toBe(await hash(encoded));
    }
    expect(await active()).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM feed_project_tags")
        .first("n"),
    ).toBe(0);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM feed_tag_aliases").first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM feed_governance_commands")
        .first("n"),
    ).toBe(2);
  },
);

it("handles invalid historical JSON syntax as evidence conflict and permits rejection", async () => {
  await db
    .prepare(
      "UPDATE feed_tag_proposals SET evidence_json='{' WHERE id='gov-assessment-one'",
    )
    .run();
  await expect(
    governance.proposal({
      proposalKind: "assessment",
      proposalId: "gov-assessment-one",
    }),
  ).rejects.toMatchObject({ status: 409, code: "governance_evidence_invalid" });
  await expect(governance.review(create())).rejects.toMatchObject({
    status: 409,
    code: "governance_evidence_invalid",
  });
  const rejected: GovernanceReview = {
    ...common(),
    action: "reject",
    proposalKind: "assessment",
    proposalId: "gov-assessment-one",
    expectedAnalysisId: "gov-analysis-one",
  };
  expect(await governance.review(rejected)).toMatchObject({
    status: "rejected",
    taxonomyVersion: 1,
  });
  expect(
    await db
      .prepare(
        "SELECT evidence_hash FROM feed_governance_commands WHERE command_id=?",
      )
      .bind(rejected.commandId)
      .first("evidence_hash"),
  ).toBe(await hash("{"));
});

it("preserves valid evidence at byte and item limits and persisted retries after evidence changes", async () => {
  const evidence = ["中".repeat(85) + "a", "😀", ...Array<string>(62).fill("")];
  await db
    .prepare(
      "UPDATE feed_tag_proposals SET evidence_json=? WHERE id='gov-assessment-one'",
    )
    .bind(JSON.stringify(evidence))
    .run();
  expect(
    (
      await governance.proposal({
        proposalKind: "assessment",
        proposalId: "gov-assessment-one",
      })
    ).proposal!.evidence,
  ).toEqual(evidence);
  const input = create(),
    result = await governance.review(input);
  await db
    .prepare(
      "UPDATE feed_tag_proposals SET evidence_json='null' WHERE id='gov-assessment-one'",
    )
    .run();
  expect(await governance.review(input)).toEqual(result);
});

it("reviews one assessment with explicit assignment and keeps same-slug proposals pending", async () => {
  const input = create(),
    result = await governance.review(input);
  expect(result).toMatchObject({
    action: "create",
    status: "mapped",
    canonicalTagId: "use_case:gov-new",
    taxonomyVersion: 2,
  });
  expect(await active()).toBe(2);
  expect(
    (
      await governance.proposal({
        proposalKind: "assessment",
        proposalId: "gov-assessment-one",
      })
    ).proposal,
  ).toMatchObject({
    status: "mapped",
    reviewedBy: input.operator,
    evidence: ["E1", "E2"],
    currentEvidence: true,
  });
  expect(
    (
      await governance.proposal({
        proposalKind: "assessment",
        proposalId: "gov-assessment-two",
      })
    ).proposal!.status,
  ).toBe("proposed");
  expect(
    (
      await governance.proposal({
        proposalKind: "user",
        proposalId: "gov-user-one",
      })
    ).proposal!.status,
  ).toBe("proposed");
  expect(
    (
      await db
        .prepare(
          "SELECT repo_key,source,weight,confidence,evidence_json,analysis_id FROM feed_project_tags",
        )
        .all()
    ).results,
  ).toEqual([
    {
      repo_key: "gov-owner/one",
      source: "admin",
      weight: 0.4,
      confidence: 0.8,
      evidence_json: '["E1","E2"]',
      analysis_id: "gov-analysis-one",
    },
  ]);
  expect(
    await db
      .prepare(
        "SELECT assignment_weight,assignment_confidence FROM feed_governance_commands WHERE command_id=?",
      )
      .bind(input.commandId)
      .first(),
  ).toEqual({ assignment_weight: 0.4, assignment_confidence: 0.8 });
  expect(await governance.command({ commandId: input.commandId })).toEqual({
    command: result,
  });
  expect(await governance.review(input)).toEqual(result);
  await expect(
    governance.review({ ...input, reason: "Changed review reason" }),
  ).rejects.toMatchObject({ status: 409, code: "governance_command_conflict" });
});

it("maps one user proposal, creates a future alias and refuses conflicting alias/canonical mappings", async () => {
  await db
    .prepare(
      "UPDATE feed_user_tag_proposals SET namespace='artifact',slug='gov-alias' WHERE id='gov-user-one'",
    )
    .run();
  const input: GovernanceReview = {
    ...common(),
    action: "map",
    proposalKind: "user",
    proposalId: "gov-user-one",
    expectedAnalysisId: "gov-analysis-one",
    canonicalTagId: "artifact:micro-tool",
    assignment: { weight: 0.25, confidence: 0.6 },
  };
  const result = await governance.review(input);
  expect(result.status).toBe("mapped");
  expect(
    await db
      .prepare(
        "SELECT canonical_tag_id FROM feed_tag_aliases WHERE namespace='artifact' AND slug='gov-alias'",
      )
      .first("canonical_tag_id"),
  ).toBe("artifact:micro-tool");
  await proposal(
    "user",
    "gov-conflict",
    "gov-owner/two",
    "gov-analysis-two",
    "artifact",
    "gov-alias",
  );
  await expect(
    governance.review({
      ...input,
      commandId: crypto.randomUUID(),
      expectedTaxonomyVersion: 2,
      proposalId: "gov-conflict",
      expectedAnalysisId: "gov-analysis-two",
      canonicalTagId: "artifact:web-app",
    }),
  ).rejects.toMatchObject({ code: "governance_tag_conflict" });
  await proposal(
    "user",
    "gov-definition",
    "gov-owner/two",
    "gov-analysis-two",
    "artifact",
    "micro-tool",
  );
  await expect(
    governance.review({
      ...input,
      commandId: crypto.randomUUID(),
      expectedTaxonomyVersion: 2,
      proposalId: "gov-definition",
      expectedAnalysisId: "gov-analysis-two",
      canonicalTagId: "artifact:web-app",
    }),
  ).rejects.toMatchObject({ code: "governance_tag_conflict" });
  expect(await active()).toBe(2);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM feed_governance_commands")
      .first("n"),
  ).toBe(1);
});

it.each(["stale", "revoked", "removed"] as const)(
  "refuses promotion of %s evidence but permits one audited rejection",
  async (condition) => {
    if (condition === "stale")
      await db
        .prepare(
          "UPDATE feed_projects SET analysis_id='new-analysis' WHERE repo_key='gov-owner/one'",
        )
        .run();
    if (condition === "revoked")
      await db
        .prepare(
          "UPDATE feed_submission_provenance SET revoked_at=1 WHERE repo_key='gov-owner/one'",
        )
        .run();
    if (condition === "removed")
      await db
        .prepare(
          "INSERT INTO feed_project_moderation(repo_key,removed,updated_at) VALUES('gov-owner/one',1,0)",
        )
        .run();
    const input = create();
    await expect(governance.review(input)).rejects.toMatchObject({
      code: "governance_evidence_changed",
    });
    expect(await active()).toBe(1);
    const rejected = await governance.review({
      ...common(),
      action: "reject",
      proposalKind: "assessment",
      proposalId: input.proposalId,
      expectedAnalysisId: input.expectedAnalysisId,
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      taxonomyVersion: 1,
      canonicalTagId: null,
    });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM feed_project_tags")
        .first("n"),
    ).toBe(0);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM feed_tag_aliases").first("n"),
    ).toBe(0);
    expect(await active()).toBe(1);
  },
);

it("serializes taxonomy CAS and coalesces simultaneous exact command retries", async () => {
  await db
    .prepare(
      "UPDATE feed_tag_proposals SET slug='gov-second' WHERE id='gov-assessment-two'",
    )
    .run();
  const input = create(),
    other = {
      ...create("gov-assessment-two"),
      expectedAnalysisId: "gov-analysis-two",
    };
  const simultaneous = await Promise.allSettled([
    governance.review(input),
    governance.review(other),
  ]);
  expect(simultaneous.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(simultaneous.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "taxonomy_version_changed" },
  });
  expect(await active()).toBe(2);
  const remaining = simultaneous[0].status === "fulfilled" ? other : input;
  const retryInput = { ...remaining, expectedTaxonomyVersion: 2 };
  const pair = await Promise.all([
    governance.review(retryInput),
    governance.review(retryInput),
  ]);
  expect(pair[0]).toEqual(pair[1]);
  expect(await active()).toBe(3);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM feed_governance_commands")
      .first("n"),
  ).toBe(2);
});

it("rolls back all governance facts when the audit insert fails", async () => {
  await db
    .prepare(
      "CREATE TRIGGER governance_test_failure BEFORE INSERT ON feed_governance_commands BEGIN SELECT RAISE(ABORT,'synthetic_governance_audit_failure'); END",
    )
    .run();
  try {
    await expect(governance.review(create())).rejects.toThrow(
      "synthetic_governance_audit_failure",
    );
    expect(await active()).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM feed_tag_definitions WHERE id='use_case:gov-new'",
        )
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM feed_project_tags")
        .first("n"),
    ).toBe(0);
    expect(
      (
        await governance.proposal({
          proposalKind: "assessment",
          proposalId: "gov-assessment-one",
        })
      ).proposal!.status,
    ).toBe("proposed");
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM feed_governance_guards")
        .first("n"),
    ).toBe(0);
  } finally {
    await db.prepare("DROP TRIGGER governance_test_failure").run();
  }
});

it("rejects evidence changed after pre-read inside the actual D1 transaction", async () => {
  let changed = false;
  const fenced = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!changed) {
            changed = true;
            await target
              .prepare(
                "UPDATE feed_projects SET analysis_id='concurrent-analysis' WHERE repo_key='gov-owner/one'",
              )
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    new FeedGovernance(fenced).review(create()),
  ).rejects.toMatchObject({ code: "governance_evidence_changed" });
  expect(await active()).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM feed_governance_commands")
      .first("n"),
  ).toBe(0);
});

it("returns immutable retries after proposal erasure and epoch changes, while rejecting new invalid commands", async () => {
  const input = { ...create("gov-user-one"), proposalKind: "user" as const },
    result = await governance.review(input);
  await db.batch([
    db.prepare("DELETE FROM feed_user_tag_proposals WHERE id='gov-user-one'"),
    db.prepare("UPDATE feed_runtime_control SET writer_epoch=2"),
  ]);
  expect(await governance.review(input)).toEqual(result);
  await expect(
    governance.review({ ...create(), expectedTaxonomyVersion: 2 }),
  ).rejects.toMatchObject({ code: "writer_epoch_changed" });
  await expect(
    governance.review({ ...input, commandId: crypto.randomUUID() }),
  ).rejects.toMatchObject({ code: "governance_proposal_not_found" });
  expect(await governance.command({ commandId: crypto.randomUUID() })).toEqual({
    command: null,
  });
  await expect(
    handleGovernance("review", { ...create(), githubId: 123 }, db),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    handleGovernance(
      "deprecate",
      {
        ...common(),
        action: "deprecate",
        canonicalTagId: "artifact:micro-tool",
      },
      db,
    ),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

it("lazily fences old sessions, requests, events and states without updating user rows", async () => {
  const ensured = await commands.ensure({
    writerEpoch: 1,
    expectedProfileVersion: 0,
    githubId: 1,
    login: "synthetic-user",
    avatarUrl: "",
  });
  const user = ensured.user!,
    now = Date.now();
  const candidate = (await commands.candidates({ githubId: 1, limit: 240 }))
    .candidates[0];
  const item = {
    project: candidate.project,
    candidateSources: ["latest"],
    reasonCodes: ["recent_project"],
    score: 0.75,
    rank: 0,
    exploration: false,
    propensity: 1,
    features: {
      productScore: 0.8,
      confidence: 0.9,
      freshness: 1,
      discoveryBoost: 1,
      mmrScore: 0.7,
    },
  };
  const session = schemas["sessions.put"].parse({
    writerEpoch: 1,
    expectedProfileVersion: 1,
    session: {
      id: "gov-session",
      githubId: 1,
      taxonomyVersion: 1,
      profileVersion: 1,
      algorithmVersion: "baseline-v1",
      pageSize: 20,
      seed: "synthetic",
      candidateCounts: { latest: 1 },
      degraded: [],
      items: [item],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 1800000).toISOString(),
    },
  });
  const request = schemas["requests.save"].parse({
    writerEpoch: 1,
    expectedProfileVersion: 1,
    payloadHash: "a".repeat(64),
    id: "gov-request",
    user,
    seed: "synthetic",
    candidateCounts: { latest: 1 },
    degraded: [],
    durationMs: 0,
    items: [item],
  });
  await commands.putSession(session);
  await commands.saveRequest(request);
  const event: Input<"events.append"> = {
    writerEpoch: 1,
    expectedProfileVersion: 1,
    githubId: 1,
    events: [
      {
        requestId: "gov-request",
        input: {
          id: "gov-impression",
          type: "impression",
          repoKey: String(candidate.project.repoKey),
          occurredAt: new Date(now).toISOString(),
          impressionToken: "private-test-reference",
        },
        metadata: { rank: 0, algorithmVersion: "baseline-v1" },
      },
    ],
  };
  await commands.events(event);
  const before = await db
    .prepare(
      "SELECT github_id,taxonomy_version,profile_version,updated_at FROM feed_users",
    )
    .all();
  await governance.review(create());
  expect(
    (
      await db
        .prepare(
          "SELECT github_id,taxonomy_version,profile_version,updated_at FROM feed_users",
        )
        .all()
    ).results,
  ).toEqual(before.results);
  expect((await commands.user(1))!.taxonomyVersion).toBe(2);
  expect(
    (
      await commands.ensure({
        writerEpoch: 1,
        expectedProfileVersion: 0,
        githubId: 1,
        login: "synthetic-user",
        avatarUrl: "",
      })
    ).user!.taxonomyVersion,
  ).toBe(2);
  expect(
    await db
      .prepare("SELECT taxonomy_version FROM feed_users WHERE github_id=1")
      .first("taxonomy_version"),
  ).toBe(1);
  await expect(
    commands.getSession({
      writerEpoch: 1,
      expectedProfileVersion: 1,
      githubId: 1,
      id: session.session.id,
    }),
  ).rejects.toMatchObject({ code: "session_not_found" });
  await expect(commands.putSession(session)).rejects.toMatchObject({
    code: "taxonomy_version_changed",
  });
  await expect(commands.saveRequest(request)).rejects.toMatchObject({
    code: "taxonomy_version_changed",
  });
  await expect(commands.events(event)).rejects.toMatchObject({
    code: "taxonomy_version_changed",
  });
  await expect(
    commands.state({
      writerEpoch: 1,
      expectedProfileVersion: 1,
      githubId: 1,
      repoKey: String(candidate.project.repoKey),
      requestId: "gov-request",
      saved: true,
      now: new Date().toISOString(),
    }),
  ).rejects.toMatchObject({ code: "taxonomy_version_changed" });
  await expect(
    commands.state({
      writerEpoch: 1,
      expectedProfileVersion: 1,
      githubId: 1,
      repoKey: String(candidate.project.repoKey),
      requestId: "unknown-request",
      saved: true,
      now: new Date().toISOString(),
    }),
  ).rejects.toMatchObject({ code: "project_not_found" });
});

it("shares canonical command digests across profiles and rejects control characters", async () => {
  const input = {
    ...digestFixture.input,
    assignment: { ...digestFixture.input.assignment, confidence: -0 },
  };
  const result = await handleGovernance("review", input, db);
  expect(
    await db
      .prepare(
        "SELECT payload_hash FROM feed_governance_commands WHERE command_id=?",
      )
      .bind(input.commandId)
      .first("payload_hash"),
  ).toBe(digestFixture.sha256);
  expect(
    await handleGovernance(
      "review",
      Object.fromEntries(Object.entries(input).reverse()),
      db,
    ),
  ).toEqual(result);
  for (const control of [
    String.fromCharCode(0),
    String.fromCharCode(10),
    String.fromCharCode(31),
    String.fromCharCode(127),
  ]) {
    await expect(
      handleGovernance(
        "review",
        { ...create(), reason: `review reason${control}` },
        db,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      handleGovernance(
        "proposal",
        { proposalKind: "assessment", proposalId: `proposal${control}` },
        db,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  }
});

it("does not map or deprecate canonical definitions from a future taxonomy", async () => {
  await db.batch([
    db.prepare(
      "UPDATE feed_tag_definitions SET taxonomy_version=99 WHERE id='artifact:micro-tool'",
    ),
    db.prepare(
      "UPDATE feed_user_tag_proposals SET namespace='artifact',slug='gov-future' WHERE id='gov-user-one'",
    ),
  ]);
  await expect(
    governance.review({
      ...common(),
      action: "map",
      proposalKind: "user",
      proposalId: "gov-user-one",
      expectedAnalysisId: "gov-analysis-one",
      canonicalTagId: "artifact:micro-tool",
      assignment: { weight: 1, confidence: 1 },
    }),
  ).rejects.toMatchObject({ code: "governance_tag_conflict" });
  await expect(
    governance.deprecate({
      ...common(),
      canonicalTagId: "artifact:micro-tool",
    }),
  ).rejects.toMatchObject({ code: "governance_not_pending" });
  expect(await active()).toBe(1);
});

it("limits effective canonical assignments to 100 and does not count or hydrate stale tags", async () => {
  const numbers = JSON.stringify(Array.from({ length: 101 }, (_, n) => n));
  await db.batch([
    db
      .prepare(
        "INSERT INTO feed_tag_definitions(id,namespace,slug,label_zh,label_en,status,taxonomy_version,created_at,updated_at) SELECT 'use_case:gov-limit-'||value,'use_case','gov-limit-'||value,'合成标签','Synthetic tag','canonical',1,0,0 FROM json_each(?)",
      )
      .bind(numbers),
    db
      .prepare(
        "INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at) SELECT 'gov-owner/one','use_case:gov-limit-'||value,'assessment',0.5,0.5,CASE WHEN value=100 THEN 'old-analysis' ELSE 'gov-analysis-one' END,1,0,0 FROM json_each(?)",
      )
      .bind(numbers),
  ]);
  await expect(governance.review(create())).rejects.toMatchObject({
    code: "governance_tag_conflict",
  });
  const mapped: GovernanceReview = {
    ...common(),
    action: "map",
    proposalKind: "assessment",
    proposalId: "gov-assessment-one",
    expectedAnalysisId: "gov-analysis-one",
    canonicalTagId: "use_case:gov-limit-100",
    assignment: { weight: 0.4, confidence: 0.8 },
  };
  await expect(governance.review(mapped)).rejects.toMatchObject({
    code: "governance_tag_conflict",
  });
  await governance.review({
    ...mapped,
    canonicalTagId: "use_case:gov-limit-0",
  });
  await commands.ensure({
    writerEpoch: 1,
    expectedProfileVersion: 0,
    githubId: 1,
    login: "synthetic-limit",
    avatarUrl: "",
  });
  const candidate = (
    await commands.candidates({ githubId: 1, limit: 240 })
  ).candidates.find((c) => c.project.repoKey === "gov-owner/one")!;
  expect(candidate.project.tags).toHaveLength(100);
  expect(
    candidate.project.tags.some((tag) => tag.id === "use_case:gov-limit-100"),
  ).toBe(false);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM feed_project_tags WHERE repo_key='gov-owner/one'",
      )
      .first("n"),
  ).toBe(101);
});

it.each([1, 520])(
  "ignores %i stale tag memberships in recall, negative filtering and behavior",
  async (count) => {
    const data = JSON.stringify(Array.from({ length: count }, (_, n) => n));
    await db.batch([
      db
        .prepare(
          "INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,analyzed_at,risks_json,published,source_hash,projected_at) SELECT 'gov-stale-'||value||'/project','current-analysis-'||value,'gov-stale-'||value,'project','https://github.com/gov-stale-'||value||'/project','SYNTHETIC historical tag fixture','micro-tool','feature-complete',80,90,'verified','low',0,'[]',1,'synthetic',0 FROM json_each(?)",
        )
        .bind(data),
      db
        .prepare(
          "INSERT INTO feed_submission_provenance(repo_key,analysis_id,source_event_id,source_version,evidence_kind,evidence_ref,submitted_at) SELECT 'gov-stale-'||value||'/project','current-analysis-'||value,'source-stale-'||value,1,'verified_historical','SYNTHETIC current evidence',0 FROM json_each(?)",
        )
        .bind(data),
      db
        .prepare(
          "INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at) SELECT 'gov-stale-'||value||'/project','artifact:web-app','assessment',1,1,'old-analysis-'||value,1,0,0 FROM json_each(?)",
        )
        .bind(data),
      db.prepare(
        "INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at) VALUES('gov-stale-0/project','artifact:micro-tool','assessment',1,1,'current-analysis-0',1,0,0)",
      ),
    ]);
    await commands.ensure({
      writerEpoch: 1,
      expectedProfileVersion: 0,
      githubId: 1,
      login: "synthetic-stale",
      avatarUrl: "",
    });
    await db
      .prepare(
        "INSERT INTO feed_user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version,updated_at) VALUES(1,'artifact:web-app',1,'explicit',1,1,0)",
      )
      .run();
    const result = await commands.candidates({ githubId: 1, limit: 240 });
    expect(result.counts.tag).toBe(0);
    expect(
      result.candidates.every(
        (candidate) =>
          !candidate.project.tags.some((tag) => tag.id === "artifact:web-app"),
      ),
    ).toBe(true);
    await db
      .prepare(
        "UPDATE feed_user_tag_preferences SET value=-1 WHERE github_id=1",
      )
      .run();
    expect(
      (
        await commands.available({
          githubId: 1,
          repoKeys: ["gov-stale-0/project"],
        })
      ).available,
    ).toEqual({ "gov-stale-0/project": true });
    await db
      .prepare(
        "INSERT INTO feed_behavior_signals(github_id,repo_key,signal,occurred_at) VALUES(1,'gov-stale-0/project','saved',0)",
      )
      .run();
    await db.batch(commands.rebuildBehavior(1, Date.now()));
    expect(
      (
        await db
          .prepare(
            "SELECT tag_id FROM feed_user_tag_preferences WHERE github_id=1 AND source='behavior'",
          )
          .all()
      ).results,
    ).toEqual([{ tag_id: "artifact:micro-tool" }]);
  },
);

it("deprecates canonical tags without rewriting references or retaining negative hard filters", async () => {
  await commands.ensure({
    writerEpoch: 1,
    expectedProfileVersion: 0,
    githubId: 1,
    login: "synthetic-user",
    avatarUrl: "",
  });
  await db.batch([
    db.prepare(
      "INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at) VALUES('gov-owner/one','artifact:micro-tool','derived',1,1,'gov-analysis-one',1,0,0)",
    ),
    db.prepare(
      "INSERT INTO feed_user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version,updated_at) VALUES(1,'artifact:micro-tool',-1,'explicit',1,1,0)",
    ),
  ]);
  expect(
    (await commands.available({ githubId: 1, repoKeys: ["gov-owner/one"] }))
      .available,
  ).toEqual({});
  const result = await governance.deprecate({
    ...common(),
    canonicalTagId: "artifact:micro-tool",
  });
  expect(result).toMatchObject({ status: "deprecated", taxonomyVersion: 2 });
  expect(Object.hasOwn(result, "proposalId")).toBe(false);
  expect((await commands.user(1))!.preferences).toEqual([]);
  expect(
    (await commands.available({ githubId: 1, repoKeys: ["gov-owner/one"] }))
      .available,
  ).toEqual({ "gov-owner/one": true });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM feed_user_tag_preferences WHERE github_id=1",
      )
      .first("n"),
  ).toBe(1);
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM feed_project_tags").first("n"),
  ).toBe(1);
  await expect(
    governance.deprecate({
      ...common(),
      expectedTaxonomyVersion: 2,
      canonicalTagId: "artifact:micro-tool",
    }),
  ).rejects.toMatchObject({ code: "governance_not_pending" });
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0009"))!;
  await db.batch(migration.queries.map((query) => db.prepare(query)));
  await db.batch(migration.queries.map((query) => db.prepare(query)));
  expect(await active()).toBe(2);
  expect(await governance.command({ commandId: result.commandId })).toEqual({
    command: result,
  });
});
