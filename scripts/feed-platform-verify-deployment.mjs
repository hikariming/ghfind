#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  validateManifest,
  validateImage,
  ACCOUNT,
} from "./feed-platform-manifest.mjs";
const [manifestPath, image, probePath, output] = process.argv.slice(2);
const m = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
validateImage(image);
const probes = JSON.parse(readFileSync(probePath, "utf8"));
if (
  probes.successful !== true ||
  probes.configuredImage !== image ||
  !probes.workerVersionId
)
  throw new Error("Passing matching probes required");
const cli = resolve("platform/runtime/node_modules/.bin/wrangler");
function wrangler(args) {
  // Never inherit the existing production Worker's root configuration.
  const scoped = args.includes("--config")
    ? args
    : [...args, "--config", "platform/runtime/wrangler.staging.generated.json"];
  return JSON.parse(
    execFileSync(cli, scoped, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CI: "true" },
    }),
  );
}
const active = wrangler([
  "deployments",
  "status",
  "--config",
  "platform/runtime/wrangler.staging.generated.json",
  "--json",
]);
if (
  active.versions?.length !== 1 ||
  active.versions[0].percentage !== 100 ||
  active.versions[0].version_id !== probes.workerVersionId
)
  throw new Error("Active Worker version differs from probe");
const apps = wrangler(["containers", "list", "--json"]);
const evidence = [];
for (const [suffix, expectedNames] of [
  ["feedapi", ["api-0", "api-1"]],
  ["feedexecutor", ["executor-0"]],
]) {
  const matches = apps.filter(
    (app) => app.name === `${m.runtimeWorker}-${suffix}`,
  );
  if (matches.length !== 1)
    throw new Error(`Container application missing or ambiguous: ${suffix}`);
  const app = matches[0];
  if (app.image !== image || app.state !== "active")
    throw new Error(`Container image/state differs: ${suffix}`);
  const result = wrangler([
    "containers",
    "instances",
    app.id,
    "--per-page",
    "10",
    "--json",
  ]);
  if (
    result.result_info?.next_page_token ||
    result.instances?.length !== expectedNames.length
  )
    throw new Error(`Unexpected instance population: ${suffix}`);
  for (const name of expectedNames) {
    const rows = result.instances.filter((instance) => instance.name === name);
    if (
      rows.length !== 1 ||
      rows[0].state !== "running" ||
      String(rows[0].version) !== String(app.version)
    )
      throw new Error(
        `Instance has not reached published image version: ${name}`,
      );
  }
  evidence.push({
    applicationId: app.id,
    name: app.name,
    image: app.image,
    version: app.version,
    instances: result.instances,
  });
}
writeFileSync(
  output,
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      workerVersionId: probes.workerVersionId,
      releaseSHA: probes.releaseSHA,
      applications: evidence,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Verified active Worker, immutable application image and every running Container app version",
);
