#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareOperatorTransport, LIMITS } from "./feed-operator.mjs";
export const GOVERNANCE_LIMITS = {
  ...LIMITS,
  commandBytes: 32 * 1024,
  maximumMutations: 1,
};

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function ensure(value, code) {
  if (!value) throw new Error(code);
}
function keys(value, expected) {
  ensure(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === expected.length &&
      Object.keys(value).every((key) => expected.includes(key)),
    "invalid_governance_fields",
  );
}
function text(value, min, max) {
  return (
    typeof value === "string" &&
    Array.from(value).every((character) => {
      const point = character.codePointAt(0);
      return point < 0xd800 || point > 0xdfff;
    }) &&
    Buffer.byteLength(value) >= min &&
    Buffer.byteLength(value) <= max &&
    (min === 0 || value.trim().length > 0) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
export function validateGovernanceCommand(command) {
  keys(command, ["target", "operation", "body"]);
  ensure(command.target === "staging", "production_operator_not_enrolled");
  const { operation, body } = command;
  ensure(
    ["proposal", "command", "review", "deprecate"].includes(operation),
    "invalid_governance_operation",
  );
  const target = ["proposalKind", "proposalId"];
  const common = [
    "commandId",
    "writerEpoch",
    "expectedTaxonomyVersion",
    "operator",
    "reason",
  ];
  if (operation === "proposal") keys(body, target);
  else if (operation === "command") keys(body, ["commandId"]);
  else if (operation === "deprecate") keys(body, [...common, "canonicalTagId"]);
  else {
    ensure(
      ["create", "map", "reject"].includes(body?.action),
      "invalid_governance_action",
    );
    keys(body, [
      ...common,
      ...target,
      "expectedAnalysisId",
      "action",
      ...(body.action === "create"
        ? ["labels", "assignment"]
        : body.action === "map"
          ? ["canonicalTagId", "assignment"]
          : []),
    ]);
  }
  if (["proposal", "review"].includes(operation)) {
    ensure(
      ["assessment", "user"].includes(body.proposalKind) &&
        text(body.proposalId, 1, 160),
      "invalid_proposal_target",
    );
  }
  if (operation !== "proposal")
    ensure(
      typeof body.commandId === "string" && uuid.test(body.commandId),
      "invalid_command_id",
    );
  if (["review", "deprecate"].includes(operation)) {
    ensure(
      body.writerEpoch === 1 &&
        Number.isSafeInteger(body.expectedTaxonomyVersion) &&
        body.expectedTaxonomyVersion > 0,
      "invalid_governance_version",
    );
    ensure(
      text(body.operator, 1, 100) && text(body.reason, 8, 500),
      "invalid_governance_audit",
    );
  }
  if (operation === "review") {
    ensure(text(body.expectedAnalysisId, 1, 160), "invalid_analysis_id");
    if (body.action !== "reject") {
      keys(body.assignment, ["weight", "confidence"]);
      ensure(
        Object.values(body.assignment).every(
          (value) =>
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 1,
        ),
        "invalid_assignment",
      );
    }
    if (body.action === "create") {
      keys(body.labels, ["labelZh", "labelEn", "description"]);
      ensure(
        text(body.labels.labelZh, 0, 160) &&
          text(body.labels.labelEn, 0, 160) &&
          text(body.labels.description, 0, 1000) &&
          !!(body.labels.labelZh.trim() || body.labels.labelEn.trim()),
        "invalid_labels",
      );
    }
  }
  if (operation === "deprecate" || body.action === "map")
    ensure(text(body.canonicalTagId, 1, 160), "invalid_canonical_target");
  ensure(
    Buffer.byteLength(JSON.stringify(body)) <= 32 * 1024,
    "governance_body_too_large",
  );
  return command;
}
function receipt(value, command) {
  if (value === null) return null;
  const body = command.body;
  ensure(
    value &&
      value.commandId === body.commandId &&
      ["create", "map", "reject", "deprecate"].includes(value.action) &&
      ["mapped", "rejected", "deprecated"].includes(value.status) &&
      Number.isSafeInteger(value.taxonomyVersion) &&
      value.taxonomyVersion > 0 &&
      Number.isSafeInteger(value.appliedAt) &&
      value.appliedAt >= 946684800000,
    "invalid_governance_receipt",
  );
  if (command.operation !== "command") {
    ensure(
      value.action ===
        (command.operation === "deprecate" ? "deprecate" : body.action) &&
        value.taxonomyVersion ===
          body.expectedTaxonomyVersion + Number(value.action !== "reject"),
      "governance_command_conflict",
    );
    if (command.operation === "review")
      ensure(
        value.proposalKind === body.proposalKind &&
          value.proposalId === body.proposalId,
        "governance_command_conflict",
      );
    if (body.canonicalTagId)
      ensure(
        value.canonicalTagId === body.canonicalTagId,
        "governance_command_conflict",
      );
  }
  ensure(
    value.status ===
      (value.action === "reject"
        ? "rejected"
        : value.action === "deprecate"
          ? "deprecated"
          : "mapped"),
    "invalid_governance_receipt",
  );
  ensure(
    value.action === "reject"
      ? value.canonicalTagId === null
      : text(value.canonicalTagId, 1, 160),
    "invalid_governance_receipt",
  );
  if (value.action !== "deprecate")
    ensure(
      ["assessment", "user"].includes(value.proposalKind) &&
        text(value.proposalId, 1, 160),
      "invalid_governance_receipt",
    );
  return Object.fromEntries(
    [
      "commandId",
      "action",
      "proposalKind",
      "proposalId",
      "canonicalTagId",
      "status",
      "taxonomyVersion",
      "appliedAt",
    ]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}
export async function executeGovernance(options) {
  const command = validateGovernanceCommand(options.command);
  const { expected, operation } = await prepareOperatorTransport(options);
  const evidence = {
    schemaVersion: 1,
    target: "staging",
    operation: command.operation,
    releaseSHA: options.sha,
    workerVersionId: expected.workerVersionId,
    observedAt: new Date().toISOString(),
    mutationAttempts: 0,
    limits: GOVERNANCE_LIMITS,
  };
  const send = (action, body) => operation("feed-governance", action, body);
  if (command.operation === "proposal") {
    const response = await send("proposal", command.body);
    ensure(
      response.ok && Object.hasOwn(response.body, "proposal"),
      "governance_proposal_unavailable",
    );
    // Actions artifacts in this public repository are public to repository
    // readers, regardless of environment protection. Raw review material is
    // available only through an explicit local private-output callback.
    const proposal = response.body.proposal;
    ensure(
      proposal === null ||
        (proposal.proposalKind === command.body.proposalKind &&
          proposal.proposalId === command.body.proposalId),
      "governance_proposal_mismatch",
    );
    evidence.proposal =
      proposal === null
        ? null
        : {
            proposalKind: command.body.proposalKind,
            proposalId: command.body.proposalId,
            contentSha256: createHash("sha256")
              .update(JSON.stringify(proposal))
              .digest("hex"),
          };
    if (options.privateProposalSink)
      await options.privateProposalSink(proposal);
    return evidence;
  }
  const read = async () => {
    const response = await send("command", {
      commandId: command.body.commandId,
    });
    ensure(
      response.ok && Object.hasOwn(response.body, "command"),
      "governance_command_unavailable",
    );
    return receipt(response.body.command, command);
  };
  evidence.commandId = command.body.commandId;
  evidence.before = await read();
  if (command.operation === "command") return evidence;
  evidence.operator = command.body.operator;
  evidence.reasonSha256 = createHash("sha256")
    .update(command.body.reason)
    .digest("hex");
  // Even if a receipt exists, submit the exact body once. Only the store can
  // compare its immutable payload hash; matching summary fields are insufficient.
  evidence.mutationAttempts = 1;
  try {
    const response = await send(command.operation, command.body);
    if (response.ok) {
      ensure(response.body !== null, "invalid_governance_receipt");
      evidence.result = receipt(response.body, command);
      evidence.commandState = "accepted";
    } else {
      evidence.commandState =
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 429].includes(response.status)
          ? "rejected"
          : "uncertain";
      evidence.error =
        typeof response.body.error === "string" &&
        /^[a-z_]{1,100}$/.test(response.body.error)
          ? response.body.error
          : "redacted_error";
    }
  } catch {
    evidence.commandState = "uncertain";
  }
  try {
    evidence.after = await read();
  } catch {
    evidence.readbackState = "unavailable";
  }
  return evidence;
}
async function main(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--plan")) {
    console.log(
      JSON.stringify(
        {
          target: "staging",
          productionEnabled: false,
          operations: ["proposal", "command", "review", "deprecate"],
          maximumMutations: 1,
          automaticRetries: 0,
          executeRequires:
            "--execute --command path --manifest path --release path --sha SHA --output path",
        },
        null,
        2,
      ),
    );
    return;
  }
  ensure(
    args[0] === "--execute" && [11, 13].includes(args.length),
    "invalid_governance_arguments",
  );
  const flags = {};
  for (let i = 1; i < args.length; i += 2) {
    ensure(
      [
        "--command",
        "--manifest",
        "--release",
        "--sha",
        "--output",
        "--private-proposal",
      ].includes(args[i]) && !Object.hasOwn(flags, args[i]),
      "invalid_governance_arguments",
    );
    flags[args[i]] = args[i + 1];
  }
  const load = (key) => {
    try {
      return JSON.parse(readFileSync(flags[key], "utf8"));
    } catch {
      throw new Error("invalid_governance_input_file");
    }
  };
  ensure(
    ["--command", "--manifest", "--release", "--sha", "--output"].every(
      (key) => flags[key],
    ),
    "invalid_governance_arguments",
  );
  const command = load("--command");
  ensure(
    !flags["--private-proposal"] ||
      (command.operation === "proposal" &&
        resolve(flags["--private-proposal"]) !== resolve(flags["--output"])),
    "invalid_private_review_output",
  );
  const result = await executeGovernance({
    command,
    manifest: load("--manifest"),
    release: load("--release"),
    sha: flags["--sha"],
    runtimeURL: process.env.FEED_STAGING_RUNTIME_URL,
    apiToken: process.env.CF_FEED_STAGING_API_TOKEN,
    opsSecret: process.env.FEED_RUNTIME_ADMIN_SECRET,
    operatorSecret: process.env.FEED_OPERATOR_SECRET,
    privateProposalSink: flags["--private-proposal"]
      ? (proposal) =>
          writeFileSync(
            flags["--private-proposal"],
            JSON.stringify(proposal, null, 2) + "\n",
            { mode: 0o600, flag: "wx" },
          )
      : undefined,
  });
  writeFileSync(flags["--output"], JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      target: result.target,
      operation: result.operation,
      commandId: result.commandId,
      commandState: result.commandState,
      mutationAttempts: result.mutationAttempts,
    }),
  );
  if (["uncertain", "rejected"].includes(result.commandState))
    process.exitCode = 2;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
