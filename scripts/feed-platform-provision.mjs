#!/usr/bin/env node
// Offline by default. Only --apply creates five empty, separately named staging
// resources. Never deploys a Worker, applies schema, changes routes or deletes.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT, template } from "./feed-platform-manifest.mjs";

const expected = template();
const forbidden = new Set([
  "60d45096-bfe7-4de1-8b85-c1b66a466b0d",
  "9c4ac13a-4c90-40a8-9d56-d7141f864bbf",
  "bd305af9-2cab-4fe8-8c2f-324391cf105e",
]);
export const definitions = Object.freeze([
  {
    kind: "d1",
    name: expected.coreDatabase.name,
    path: "/d1/database",
    body: { name: expected.coreDatabase.name },
  },
  {
    kind: "d1",
    name: expected.feedDatabase.name,
    path: "/d1/database",
    body: { name: expected.feedDatabase.name },
  },
  {
    kind: "r2",
    name: expected.archiveBucket,
    path: "/r2/buckets",
    body: { name: expected.archiveBucket },
  },
  {
    kind: "queue",
    name: expected.deadLetterQueue,
    path: "/queues",
    body: { queue_name: expected.deadLetterQueue },
  },
  {
    kind: "queue",
    name: expected.queue,
    path: "/queues",
    body: { queue_name: expected.queue },
  },
]);
for (const definition of definitions) {
  Object.freeze(definition.body);
  Object.freeze(definition);
}
export const planHash = createHash("sha256")
  .update(JSON.stringify({ accountId: ACCOUNT, definitions }))
  .digest("hex");
export function plan() {
  return {
    mode: "dry-run",
    accountId: ACCOUNT,
    planHash,
    operations: definitions.map((d) => ({
      method: "POST",
      path: `/accounts/${ACCOUNT}${d.path}`,
      body: d.body,
    })),
    limits: { creates: 5, automaticRetries: 0, deletes: 0 },
    credentialEnvironment: "CLOUDFLARE_API_TOKEN",
    note: "Review this plan; --inspect is read-only. --apply requires this plan hash and a persistent receipt. Unknown pre-existing names and uncertain creates stop for reconciliation.",
  };
}
export function newReceipt() {
  return {
    schemaVersion: 1,
    accountId: ACCOUNT,
    planHash,
    status: "in_progress",
    resources: [],
    pending: null,
    updatedAt: new Date().toISOString(),
  };
}
function inspectionPath(d) {
  return d.kind === "r2"
    ? `${d.path}/${d.name}`
    : `${d.path}?name=${encodeURIComponent(d.name)}&per_page=100&page=1`;
}
function validateResource(d, value) {
  const id =
    d.kind === "d1"
      ? value?.uuid
      : d.kind === "queue"
        ? value?.queue_id
        : value?.name;
  const name = d.kind === "queue" ? value?.queue_name : value?.name;
  if (name !== d.name || typeof id !== "string" || !id || forbidden.has(id))
    throw new Error("unsafe_resource_identity");
  if (
    d.kind === "d1" &&
    (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
      /^0{8}-/.test(id))
  )
    throw new Error("unsafe_database_id");
  if (d.kind === "queue" && !/^[a-f0-9]{32}$/.test(id))
    throw new Error("invalid_queue_id");
  return { kind: d.kind, name: d.name, id };
}
function validateReceipt(receipt) {
  const fields = [
    "schemaVersion",
    "accountId",
    "planHash",
    "status",
    "resources",
    "pending",
    "updatedAt",
  ];
  if (
    !receipt ||
    Object.keys(receipt).length !== fields.length ||
    Object.keys(receipt).some((k) => !fields.includes(k)) ||
    receipt.schemaVersion !== 1 ||
    receipt.accountId !== ACCOUNT ||
    receipt.planHash !== planHash ||
    !["in_progress", "completed", "uncertain"].includes(receipt.status) ||
    !Array.isArray(receipt.resources)
  )
    throw new Error("invalid_provision_receipt");
  const seen = new Set();
  for (const resource of receipt.resources) {
    const d = definitions.find(
      (d) => d.name === resource.name && d.kind === resource.kind,
    );
    if (
      !d ||
      seen.has(resource.name) ||
      Object.keys(resource).sort().join(",") !== "id,kind,name"
    )
      throw new Error("invalid_recorded_resource");
    seen.add(resource.name);
    validateResource(
      d,
      d.kind === "d1"
        ? { name: d.name, uuid: resource.id }
        : d.kind === "queue"
          ? { queue_name: d.name, queue_id: resource.id }
          : { name: resource.id },
    );
  }
  if (receipt.pending !== null) {
    if (
      !definitions.some(
        (d) =>
          d.name === receipt.pending.name && d.kind === receipt.pending.kind,
      ) ||
      Object.keys(receipt.pending).sort().join(",") !== "kind,name"
    )
      throw new Error("invalid_pending_resource");
  }
  return receipt;
}
async function discover(d, request) {
  const path = inspectionPath(d);
  const response = await request({ method: "GET", path });
  if (d.kind === "r2" && response.status === 404) return null;
  if (response.status !== 200 || response.success !== true)
    throw new Error(
      `resource_inspection_failed:${d.name}:HTTP${response.status}`,
    );
  if (d.kind === "r2") return validateResource(d, response.result);
  if (
    !Array.isArray(response.result) ||
    response.result_info?.total_pages > 1 ||
    response.result_info?.total_count > 100
  )
    throw new Error("incomplete_resource_listing");
  const matches = response.result.filter(
    (v) => (d.kind === "d1" ? v.name : v.queue_name) === d.name,
  );
  if (matches.length > 1) throw new Error(`ambiguous_resource_name:${d.name}`);
  return matches.length === 1 ? validateResource(d, matches[0]) : null;
}
export async function inspect(request) {
  const resources = [];
  for (const d of definitions)
    resources.push({
      kind: d.kind,
      name: d.name,
      existing: await discover(d, request),
    });
  return { accountId: ACCOUNT, planHash, mode: "read-only", resources };
}
export async function provision({
  request,
  receipt = newReceipt(),
  reviewedPlanHash,
  onReceipt,
}) {
  if (reviewedPlanHash !== planHash)
    throw new Error("reviewed_plan_hash_required");
  if (typeof request !== "function" || typeof onReceipt !== "function")
    throw new Error("authenticated_transport_and_durable_receipt_required");
  validateReceipt(receipt);
  // Validate every existing name before the first mutation. Never adopt unknown
  // resources based on name alone or treat a 403/listing error as absence.
  const inventory = await inspect(request);
  for (const row of inventory.resources) {
    const recorded = receipt.resources.find((r) => r.name === row.name);
    if (row.existing && (!recorded || recorded.id !== row.existing.id))
      throw new Error(`unrecorded_or_changed_resource:${row.name}`);
    if (recorded && !row.existing)
      throw new Error(`recorded_resource_missing:${row.name}`);
  }
  if (receipt.pending !== null || receipt.status === "uncertain")
    throw new Error("uncertain_create_requires_read_only_reconciliation");
  const ids = receipt.resources.filter((r) => r.kind === "d1").map((r) => r.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("staging_databases_must_be_distinct");
  if (
    receipt.status === "completed" &&
    receipt.resources.length !== definitions.length
  )
    throw new Error("incomplete_receipt_claims_completion");
  async function persist() {
    receipt.updatedAt = new Date().toISOString();
    await onReceipt(structuredClone(receipt));
  }
  for (const d of definitions) {
    if (receipt.resources.some((r) => r.name === d.name)) continue;
    receipt.status = "in_progress";
    receipt.pending = { kind: d.kind, name: d.name };
    await persist();
    try {
      const response = await request({
        method: "POST",
        path: d.path,
        body: d.body,
      });
      if (
        response.status < 200 ||
        response.status >= 300 ||
        response.success !== true
      )
        throw new Error(`create_failed:${d.name}:HTTP${response.status}`);
      const resource = validateResource(d, response.result);
      if (
        resource.kind === "d1" &&
        receipt.resources.some((r) => r.kind === "d1" && r.id === resource.id)
      )
        throw new Error("staging_databases_must_be_distinct");
      // Confirm the returned ID through a separate GET before recording success.
      const observed = await discover(d, request);
      if (!observed || observed.id !== resource.id)
        throw new Error("created_resource_readback_mismatch");
      receipt.resources.push(resource);
      receipt.pending = null;
      await persist();
    } catch (error) {
      receipt.status = "uncertain";
      await persist();
      // No retry or cleanup can safely assume a timed-out create did not commit.
      throw error;
    }
  }
  receipt.status = "completed";
  await persist();
  return receipt;
}
export function authenticatedTransport(token) {
  if (typeof token !== "string" || !token)
    throw new Error("CLOUDFLARE_API_TOKEN_required");
  return async ({ method, path, body }) => {
    if (
      !(
        method === "GET" &&
        body === undefined &&
        definitions.some((d) => inspectionPath(d) === path)
      ) &&
      !(
        method === "POST" &&
        definitions.some(
          (d) =>
            d.path === path && JSON.stringify(d.body) === JSON.stringify(body),
        )
      )
    )
      throw new Error("forbidden_provision_operation");
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      },
    );
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 1024 * 1024) throw new Error("oversized_cloudflare_response");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`invalid_cloudflare_response:HTTP${response.status}`);
    }
    return {
      status: response.status,
      success: data.success,
      result: data.result,
      result_info: data.result_info,
    };
  };
}
async function main(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--plan")) {
    console.log(JSON.stringify(plan(), null, 2));
    return;
  }
  if (args.length === 1 && args[0] === "--inspect") {
    console.log(
      JSON.stringify(
        await inspect(authenticatedTransport(process.env.CLOUDFLARE_API_TOKEN)),
        null,
        2,
      ),
    );
    return;
  }
  if (
    args.length !== 5 ||
    args[0] !== "--apply" ||
    args[1] !== "--reviewed-plan" ||
    args[3] !== "--receipt"
  )
    throw new Error(
      "usage: --plan | --inspect | --apply --reviewed-plan HASH --receipt platform/runtime/provision.evidence.json",
    );
  const output = resolve(args[4]);
  const allowed = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../platform/runtime/provision.evidence.json",
  );
  if (output !== allowed)
    throw new Error("receipt_must_use_ignored_staging_provision_path");
  if (existsSync(output) && lstatSync(output).isSymbolicLink())
    throw new Error("receipt_symlink_rejected");
  const receipt = existsSync(output)
    ? JSON.parse(readFileSync(output, "utf8"))
    : newReceipt();
  const result = await provision({
    request: authenticatedTransport(process.env.CLOUDFLARE_API_TOKEN),
    receipt,
    reviewedPlanHash: args[2],
    onReceipt: (value) => {
      const temporary = `${output}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, output);
    },
  });
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
