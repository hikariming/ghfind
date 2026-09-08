#!/usr/bin/env node
// The enrolled target is staging only. Production requires a reviewed resource
// manifest and an explicit enrollment change; there is no URL override flag.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT,
  validateManifest,
  validateImage,
} from "./feed-platform-manifest.mjs";
export const LIMITS = {
  managementReads: 3,
  runtimeHealthReads: 1,
  statusReads: 2,
  replayWrites: 1,
  automaticRetries: 0,
  requestTimeoutMs: 10000,
  responseBytes: 65536,
  commandBytes: 2048,
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function ensure(value, code) {
  if (!value) throw new Error(code);
}
export function runCommandId(repository, runId, kind, id) {
  ensure(
    repository === "hikariming/ghfind" && /^\d+$/.test(runId),
    "invalid_action_identity",
  );
  const hash = createHash("sha256")
    .update(JSON.stringify([repository, runId, "staging", kind, id]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function validateCommand(command) {
  ensure(
    command && typeof command === "object" && !Array.isArray(command),
    "invalid_command",
  );
  ensure(command.target === "staging", "production_operator_not_enrolled");
  ensure(
    ["status", "replay"].includes(command.action) &&
      ["sourceEvent", "deletion", "coreSource"].includes(command.kind),
    "invalid_operation",
  );
  const keys = [
    "action",
    "target",
    "kind",
    "id",
    ...(command.action === "replay" ? ["commandId", "operator", "reason"] : []),
  ];
  ensure(
    Object.keys(command).length === keys.length &&
      Object.keys(command).every((key) => keys.includes(key)),
    "unexpected_command_fields",
  );
  ensure(
    typeof command.id === "string" &&
      /^[A-Za-z0-9_.:-]{1,160}$/.test(command.id),
    "invalid_target_id",
  );
  if (command.kind === "coreSource")
    ensure(
      /^[1-9][0-9]{0,15}$/.test(command.id) &&
        Number.isSafeInteger(Number(command.id)),
      "invalid_source_sequence",
    );
  if (command.action === "replay") {
    ensure(
      typeof command.commandId === "string" && uuid.test(command.commandId),
      "invalid_command_id",
    );
    ensure(
      typeof command.operator === "string" &&
        command.operator.length >= 1 &&
        command.operator.length <= 100 &&
        !/[\u0000-\u001f\u007f]/.test(command.operator),
      "invalid_operator",
    );
    ensure(
      typeof command.reason === "string" &&
        command.reason.trim().length >= 8 &&
        command.reason.length <= 500 &&
        !/[\u0000-\u001f\u007f]/.test(command.reason),
      "invalid_reason",
    );
  }
  ensure(
    Buffer.byteLength(
      JSON.stringify(capabilityBody(command, command.action)),
    ) <= LIMITS.commandBytes,
    "operator_body_too_large",
  );
  return command;
}
function capabilityBody(command, action) {
  return {
    kind: command.kind,
    id: command.id,
    ...(action === "replay"
      ? {
          ...(command.kind === "coreSource" ? {} : { writerEpoch: 1 }),
          commandId: command.commandId,
          operator: command.operator,
          reason: command.reason,
        }
      : {}),
  };
}
function safeCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value)
    ? value
    : value == null
      ? null
      : "redacted_error_code";
}
function metadata(value, allowed) {
  if (value == null) return null;
  ensure(
    typeof value === "object" && !Array.isArray(value),
    "invalid_status_metadata",
  );
  const result = {};
  for (const [key, kind] of Object.entries(allowed)) {
    const item = value[key];
    if (item === undefined) continue;
    if (item === null) {
      result[key] = null;
      continue;
    }
    if (kind === "code") {
      result[key] = safeCode(item);
      continue;
    }
    ensure(
      kind === "number"
        ? Number.isSafeInteger(item) && item >= 0
        : kind === "boolean"
          ? typeof item === "boolean"
          : typeof item === "string" &&
            item.length <= 200 &&
            !/[\u0000-\u001f\u007f]/.test(item),
      "invalid_status_metadata",
    );
    result[key] = item;
  }
  return result;
}
export function statusEvidence(data, id) {
  ensure(
    data && typeof data === "object" && Object.hasOwn(data, "job"),
    "invalid_status_response",
  );
  const job = metadata(data.job, {
    id: "string",
    status: "string",
    phase: "string",
    sourceKind: "string",
    sequence: "number",
    replayCount: "number",
    replayedAt: "number",
    attempts: "number",
    failures: "number",
    claims: "number",
    primaryTable: "number",
    archiveScanDone: "number",
    availableAt: "number",
    leaseUntil: "number",
    lastError: "code",
  });
  ensure(job === null || job.id === id, "status_target_mismatch");
  return {
    job,
    delivery: metadata(data.delivery, {
      deliveryId: "string",
      status: "string",
      attempts: "number",
      availableAt: "number",
      leaseUntil: "number",
      lastError: "code",
      publishedAt: "number",
    }),
    terminalEvidence: metadata(data.terminalEvidence, {
      deliveryId: "string",
      messageId: "string",
      queue: "string",
      attempts: "number",
      receivedAt: "number",
      isCurrent: "boolean",
    }),
  };
}
export function validateRelease(release, manifest, sha) {
  validateManifest(manifest);
  ensure(
    /^[a-f0-9]{40}$/.test(sha) &&
      release?.releaseSHA === sha &&
      uuid.test(release.workerVersionId) &&
      Number.isFinite(Date.parse(release.verifiedAt)),
    "invalid_release_evidence",
  );
  ensure(
    Array.isArray(release.applications) && release.applications.length === 2,
    "missing_container_release_evidence",
  );
  let image;
  for (const suffix of ["feedapi", "feedexecutor"]) {
    const apps = release.applications.filter(
      (app) => app.name === `${manifest.runtimeWorker}-${suffix}`,
    );
    ensure(apps.length === 1, "container_release_name_mismatch");
    validateImage(apps[0].image);
    ensure(!image || image === apps[0].image, "mixed_container_images");
    image = apps[0].image;
  }
  return { sha, workerVersionId: release.workerVersionId, image };
}
async function smallJSON(response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength;
    ensure(length <= LIMITS.responseBytes, "operator_response_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_operator_response");
  }
}
function binding(settings, name, type) {
  const matches = settings?.bindings?.filter(
    (value) => value.name === name && value.type === type,
  );
  ensure(matches?.length === 1, `missing_binding_${name}`);
  return matches[0];
}
export async function executeOperator({
  command,
  manifest,
  release,
  sha,
  runtimeURL,
  apiToken,
  opsSecret,
  operatorSecret,
  fetcher = fetch,
}) {
  validateCommand(command);
  const expected = validateRelease(release, manifest, sha);
  ensure(
    typeof apiToken === "string" && apiToken.length > 0,
    "missing_metadata_read_credential",
  );
  ensure(
    [opsSecret, operatorSecret].every(
      (v) => typeof v === "string" && Buffer.byteLength(v) >= 32,
    ) && opsSecret !== operatorSecret,
    "independent_operator_credentials_required",
  );
  let requests = 0;
  async function request(url, init) {
    ensure(++requests <= 7, "operator_request_budget_exceeded");
    try {
      return await fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
        redirect: "error",
      });
    } catch {
      throw new Error("operator_transport_unavailable");
    }
  }
  async function management(path) {
    const response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,
      { method: "GET", headers: { authorization: `Bearer ${apiToken}` } },
    );
    ensure(response.ok, "operator_metadata_read_failed");
    const data = await smallJSON(response);
    ensure(data.success === true, "operator_metadata_read_failed");
    return data.result;
  }
  // Pin the workers.dev origin to this actual account, then verify both service
  // bindings and database IDs before sending either privileged operator token.
  const domain = await management("/workers/subdomain");
  ensure(
    typeof domain.subdomain === "string" &&
      /^[a-z0-9-]+$/.test(domain.subdomain),
    "invalid_account_subdomain",
  );
  const origin = `https://${manifest.runtimeWorker}.${domain.subdomain}.workers.dev`;
  const supplied = new URL(runtimeURL);
  ensure(
    supplied.origin === origin &&
      supplied.pathname === "/" &&
      !supplied.username &&
      !supplied.password &&
      !supplied.search &&
      !supplied.hash,
    "operator_origin_not_enrolled",
  );
  const runtime = await management(
    `/workers/scripts/${manifest.runtimeWorker}/settings`,
  );
  const service = binding(runtime, "FEED_ADAPTER", "service");
  ensure(
    service.service === manifest.adapterWorker &&
      (!service.environment || service.environment === "production") &&
      !service.entrypoint,
    "operator_adapter_target_mismatch",
  );
  for (const [name, value] of [
    ["FEED_ENVIRONMENT", "staging"],
    ["FEED_RELEASE_SHA", sha],
    ["FEED_WRITER_EPOCH", "1"],
  ])
    ensure(
      binding(runtime, name, "plain_text").text === value,
      "operator_runtime_context_mismatch",
    );
  const adapter = await management(
    `/workers/scripts/${manifest.adapterWorker}/settings`,
  );
  for (const [name, resource] of [
    ["FEED_DB", manifest.feedDatabase],
    ["CORE_DB", manifest.coreDatabase],
  ])
    ensure(
      binding(adapter, name, "d1").id === resource.id,
      "operator_database_target_mismatch",
    );
  ensure(
    binding(adapter, "FEED_ARCHIVE", "r2_bucket").bucket_name ===
      manifest.archiveBucket,
    "operator_archive_target_mismatch",
  );
  const healthResponse = await request(`${origin}/healthz`, { method: "GET" });
  ensure(healthResponse.ok, "runtime_health_unavailable");
  const health = await smallJSON(healthResponse);
  ensure(
    health.healthy === true &&
      health.version === sha &&
      health.workerVersionId === expected.workerVersionId &&
      health.contractVersion === "1",
    "operator_running_version_mismatch",
  );
  async function operation(action) {
    const response = await request(
      `${origin}/internal/runtime/feed-admin/v1/${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${opsSecret}`,
          "x-feed-operator": operatorSecret,
          "x-feed-contract": "1",
          "x-feed-target": "staging",
          "x-feed-release": sha,
          "x-feed-writer-epoch": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify(capabilityBody(command, action)),
      },
    );
    const body = await smallJSON(response);
    return { ok: response.ok, status: response.status, body };
  }
  const before = await operation("status");
  ensure(before.ok, "operator_status_unavailable");
  const evidence = {
    schemaVersion: 1,
    target: "staging",
    action: command.action,
    kind: command.kind,
    id: command.id,
    releaseSHA: sha,
    workerVersionId: expected.workerVersionId,
    checkedAt: new Date().toISOString(),
    before: statusEvidence(before.body, command.id),
    commandState: "not_requested",
    executionState: "observed",
    limits: LIMITS,
  };
  if (command.action === "status") return evidence;
  evidence.commandId = command.commandId;
  evidence.operator = command.operator;
  evidence.reasonSha256 = createHash("sha256")
    .update(command.reason)
    .digest("hex");
  // A timeout may occur after the transaction commits. Never retry with a new
  // command ID, and never treat {ok:true} as evidence of executor completion.
  try {
    const replay = await operation("replay");
    evidence.commandState =
      replay.ok && replay.body.ok === true ? "accepted" : "rejected";
    if (evidence.commandState === "rejected")
      evidence.error = safeCode(replay.body.error);
  } catch {
    evidence.commandState = "uncertain";
  }
  try {
    const after = await operation("status");
    ensure(after.ok, "operator_status_unavailable");
    evidence.after = statusEvidence(after.body, command.id);
    evidence.executionState =
      command.kind === "coreSource" &&
      evidence.after.job?.status === "delivered"
        ? "source_delivered"
        : evidence.after.job?.status === "completed"
          ? "completed"
          : "incomplete";
  } catch {
    evidence.executionState = "unknown";
  }
  return evidence;
}
async function main(args) {
  if (args.length === 0 || args[0] === "--plan") {
    console.log(
      JSON.stringify(
        {
          target: "staging",
          productionEnabled: false,
          actions: ["status", "replay"],
          limits: LIMITS,
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
    args[0] === "--execute" && args.length === 11,
    "invalid_operator_arguments",
  );
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    ensure(
      ["--command", "--manifest", "--release", "--sha", "--output"].includes(
        args[i],
      ) && !Object.hasOwn(options, args[i]),
      "invalid_operator_arguments",
    );
    options[args[i]] = args[i + 1];
  }
  const load = (key) => JSON.parse(readFileSync(options[key], "utf8"));
  const result = await executeOperator({
    command: load("--command"),
    manifest: load("--manifest"),
    release: load("--release"),
    sha: options["--sha"],
    runtimeURL: process.env.FEED_STAGING_RUNTIME_URL,
    apiToken: process.env.CF_FEED_STAGING_API_TOKEN,
    opsSecret: process.env.FEED_RUNTIME_ADMIN_SECRET,
    operatorSecret: process.env.FEED_OPERATOR_SECRET,
  });
  writeFileSync(options["--output"], JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      target: result.target,
      action: result.action,
      commandId: result.commandId,
      commandState: result.commandState,
      executionState: result.executionState,
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
