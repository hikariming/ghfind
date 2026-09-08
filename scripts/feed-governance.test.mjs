import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { template, ACCOUNT } from "./feed-platform-manifest.mjs";
import {
  validateGovernanceCommand,
  executeGovernance,
} from "./feed-governance.mjs";

function fixture() {
  const sha = "a".repeat(40),
    workerVersionId = "12345678-1234-4234-8234-123456789012";
  const manifest = template();
  manifest.coreDatabase.id = "12345678-1234-4234-8234-123456789013";
  manifest.feedDatabase.id = "12345678-1234-4234-8234-123456789014";
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
  const release = {
    releaseSHA: sha,
    workerVersionId,
    verifiedAt: "2026-09-08T00:00:00Z",
    applications: ["feedapi", "feedexecutor"].map((suffix) => ({
      name: `${manifest.runtimeWorker}-${suffix}`,
      image: `registry.cloudflare.com/${ACCOUNT}/ghfind-feed@sha256:${"b".repeat(64)}`,
    })),
  };
  const command = {
    target: "staging",
    operation: "review",
    body: {
      commandId: "12345678-1234-4234-8234-123456789015",
      writerEpoch: 1,
      expectedTaxonomyVersion: 1,
      operator: "reviewer",
      reason: "Reviewed project evidence",
      proposalKind: "assessment",
      proposalId: "proposal-1",
      expectedAnalysisId: "analysis-1",
      action: "map",
      canonicalTagId: "domain:ai",
      assignment: { weight: 0.7, confidence: 0.9 },
    },
  };
  const calls = [],
    state = {
      result: null,
      failAfterCommit: false,
      refuse: false,
      badTarget: false,
    };
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    assert.equal(init.redirect, "error");
    if (url.startsWith("https://api.cloudflare.com/")) {
      assert.equal(init.method, "GET");
      assert.equal(init.headers.authorization, "Bearer metadata-only");
      const result = path.endsWith("/subdomain")
        ? { subdomain: "fixture" }
        : path.includes(manifest.runtimeWorker)
          ? {
              bindings: [
                {
                  name: "FEED_ADAPTER",
                  type: "service",
                  service: manifest.adapterWorker,
                },
                ...Object.entries({
                  FEED_ENVIRONMENT: "staging",
                  FEED_RELEASE_SHA: sha,
                  FEED_WRITER_EPOCH: "1",
                }).map(([name, text]) => ({ name, type: "plain_text", text })),
              ],
            }
          : {
              bindings: [
                {
                  name: "FEED_DB",
                  type: "d1",
                  id: state.badTarget
                    ? manifest.coreDatabase.id
                    : manifest.feedDatabase.id,
                },
                { name: "CORE_DB", type: "d1", id: manifest.coreDatabase.id },
                {
                  name: "FEED_ARCHIVE",
                  type: "r2_bucket",
                  bucket_name: manifest.archiveBucket,
                },
              ],
            };
      return Response.json({ success: true, result });
    }
    if (path === "/healthz") {
      assert.equal(init.headers, undefined);
      return Response.json({
        healthy: true,
        version: sha,
        workerVersionId,
        contractVersion: "1",
      });
    }
    assert.equal(init.headers.authorization, `Bearer ${"r".repeat(32)}`);
    assert.equal(init.headers["x-feed-operator"], "o".repeat(32));
    if (path.endsWith("/command"))
      return Response.json({ command: state.result });
    if (path.endsWith("/proposal"))
      return Response.json({
        proposal: { ...command.body, evidence: ["Approved summary"] },
      });
    assert.equal(path, "/internal/runtime/feed-governance/v1/review");
    if (state.refuse)
      return Response.json(
        { error: "taxonomy_version_changed" },
        { status: 409 },
      );
    state.result = {
      commandId: command.body.commandId,
      action: "map",
      proposalKind: "assessment",
      proposalId: "proposal-1",
      canonicalTagId: "domain:ai",
      status: "mapped",
      taxonomyVersion: 2,
      appliedAt: 1788840000000,
    };
    if (state.failAfterCommit)
      throw new Error("lost response containing secret");
    return Response.json(state.result);
  };
  return {
    state,
    calls,
    options: {
      command,
      manifest,
      release,
      sha,
      runtimeURL: `https://${manifest.runtimeWorker}.fixture.workers.dev`,
      apiToken: "metadata-only",
      opsSecret: "r".repeat(32),
      operatorSecret: "o".repeat(32),
      fetcher,
    },
  };
}
test("default is offline and strict commands cannot select production, SQL, arbitrary evidence or omitted assignment", () => {
  assert.equal(
    JSON.parse(
      execFileSync(process.execPath, ["scripts/feed-governance.mjs"], {
        encoding: "utf8",
      }),
    ).maximumMutations,
    1,
  );
  const command = fixture().options.command;
  validateGovernanceCommand(command);
  for (const change of [
    (c) => (c.target = "production"),
    (c) => (c.operation = "sql"),
    (c) => (c.body.evidence = ["forged"]),
    (c) => delete c.body.assignment,
    (c) => (c.body.assignment.confidence = 1.1),
    (c) => (c.body.reason = "短"),
    (c) => (c.body.operator = "reviewer\nforged"),
    (c) => (c.body.writerEpoch = 2),
  ]) {
    const copy = structuredClone(command);
    change(copy);
    assert.throws(() => validateGovernanceCommand(copy));
  }
});
test("one command verifies deployed identities and preserves immutable receipt without printing proposal/audit text", async () => {
  const f = fixture();
  const result = await executeGovernance(f.options);
  assert.equal(f.calls.length, 7);
  assert.equal(result.commandState, "accepted");
  assert.equal(result.after.taxonomyVersion, 2);
  assert.equal(result.mutationAttempts, 1);
  assert.equal(
    JSON.stringify(result).includes(f.options.command.body.reason),
    false,
  );
});
test("wrong database stops before privileged calls; uncertain commit is read back without retry", async () => {
  const bad = fixture();
  bad.state.badTarget = true;
  await assert.rejects(executeGovernance(bad.options));
  assert.equal(bad.calls.length, 3);
  const f = fixture();
  f.state.failAfterCommit = true;
  const result = await executeGovernance(f.options);
  assert.equal(result.commandState, "uncertain");
  assert.equal(result.after.commandId, f.options.command.body.commandId);
  assert.equal(
    f.calls.filter((call) => call.url.endsWith("/review")).length,
    1,
  );
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
test("rejected command is not reported applied and proposal/read-only command never mutates", async () => {
  const f = fixture();
  f.state.refuse = true;
  assert.equal((await executeGovernance(f.options)).commandState, "rejected");
  for (const operation of ["proposal", "command"]) {
    const g = fixture();
    g.options.command = {
      target: "staging",
      operation,
      body:
        operation === "proposal"
          ? { proposalKind: "assessment", proposalId: "proposal-1" }
          : { commandId: g.options.command.body.commandId },
    };
    const result = await executeGovernance(g.options);
    assert.equal(result.mutationAttempts, 0);
    assert.equal(g.calls.length, 5);
  }
});
test("a 5xx after commit and invalid success receipts remain uncertain without a second mutation", async () => {
  for (const replacement of [
    () => Response.json({ error: "unavailable" }, { status: 503 }),
    () => Response.json(null),
    () => Response.json({}),
  ]) {
    const f = fixture(),
      original = f.options.fetcher;
    f.options.fetcher = async (url, init) => {
      const response = await original(url, init);
      return url.endsWith("/review") ? replacement() : response;
    };
    const result = await executeGovernance(f.options);
    assert.equal(result.commandState, "uncertain");
    assert.equal(result.after.status, "mapped");
    assert.equal(result.mutationAttempts, 1);
    assert.equal(
      f.calls.filter((call) => call.url.endsWith("/review")).length,
      1,
    );
  }
});
test("public artifacts exclude raw review content while an explicit local sink can receive it", async () => {
  const f = fixture();
  f.options.command = {
    target: "staging",
    operation: "proposal",
    body: { proposalKind: "assessment", proposalId: "proposal-1" },
  };
  let privateMaterial;
  f.options.privateProposalSink = (value) => {
    privateMaterial = value;
  };
  const result = await executeGovernance(f.options);
  assert.deepEqual(privateMaterial.evidence, ["Approved summary"]);
  assert.equal(JSON.stringify(result).includes("Approved summary"), false);
  assert.equal(JSON.stringify(result).includes("reason"), false);
  assert.match(result.proposal.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.limits.commandBytes, 32768);
  const workflow = readFileSync(
    ".github/workflows/feed-governance.yml",
    "utf8",
  );
  assert.equal(workflow.includes("${{ inputs.command_json }}"), false);
  assert.equal(workflow.includes("--private-proposal"), false);
  assert.match(workflow, /GITHUB_EVENT_PATH/);
});
