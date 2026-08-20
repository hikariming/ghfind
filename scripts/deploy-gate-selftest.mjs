#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeJSON(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function runGate(workspace, fixture, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repository, ".github/scripts/deploy-gate.mjs"), "rollback"],
      {
        cwd: repository,
        env: {
          ...process.env,
          PATH: `${path.join(workspace, "bin")}:${process.env.PATH || ""}`,
          GITHUB_WORKSPACE: workspace,
          DEPLOY_GATE_SELFTEST: "1",
          DEPLOY_GATE_RAILWAY_GQL: `${fixture}/graphql/v2`,
          DEPLOY_GATE_VERCEL_API: fixture,
          DEPLOY_GATE_DOWN_MARKER: marker,
          RAILWAY_TOKEN: "test-railway-token",
          RAILWAY_PROJECT_ID: "project",
          RAILWAY_ENVIRONMENT_ID: "environment",
          RAILWAY_API_SERVICE: "api",
          RAILWAY_WORKER_SERVICE: "worker",
          RAILWAY_BACKUP_SERVICE: "backup",
          RAILWAY_API_ORIGIN: `${fixture}/api`,
          RAILWAY_WORKER_ORIGIN: `${fixture}/worker`,
          VERCEL_TOKEN: "test-vercel-token",
          VERCEL_ORG_ID: "org",
          VERCEL_PROJECT_ID: "vercel-project",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

async function main() {
  const workspace = mkdtempSync(path.join(tmpdir(), "ghfind-deploy-gate-test-"));
  const marker = path.join(workspace, "railway-down.txt");
  const bin = path.join(workspace, "bin");
  const state = {
    failAPIRedeploy: false,
    apiRedeployed: false,
    workerRedeployed: false,
  };

  // Only `railway down` should be needed in the happy path: API and worker use
  // the GraphQL anchor redeploy, while a first-ever backup deployment has no
  // anchor and must be removed exactly.
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const fakeRailway = path.join(bin, "railway");
  writeFileSync(
    fakeRailway,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "down") {
  console.error("unexpected fake railway command: " + args.join(" "));
  process.exit(2);
}
writeFileSync(process.env.DEPLOY_GATE_DOWN_MARKER, args.join(" "));
`,
  );
  chmodSync(fakeRailway, 0o755);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://fixture");
    if (url.pathname === "/graphql/v2") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (payload.query.includes("deploymentRedeploy")) {
        if (payload.variables.id === "api-anchor" && state.failAPIRedeploy) {
          writeJSON(response, 200, { errors: [{ message: "forced redeploy failure" }] });
          return;
        }
        if (payload.variables.id === "api-anchor") state.apiRedeployed = true;
        if (payload.variables.id === "worker-anchor") state.workerRedeployed = true;
        const id = payload.variables.id === "api-anchor" ? "api-rollback" : "worker-rollback";
        writeJSON(response, 200, { data: { deploymentRedeploy: { id, status: "BUILDING" } } });
        return;
      }
      const service = payload.variables.input.serviceId;
      let deployments = [];
      if (service === "api") {
        deployments = [
          state.apiRedeployed
            ? { id: "api-rollback", status: "SUCCESS", createdAt: "now" }
            : { id: "api-new", status: "SUCCESS", createdAt: "now" },
        ];
      } else if (service === "worker") {
        deployments = [
          state.workerRedeployed
            ? { id: "worker-rollback", status: "SUCCESS", createdAt: "now" }
            : { id: "worker-new", status: "SUCCESS", createdAt: "now" },
        ];
      } else if (service === "backup" && !existsSync(marker)) {
        deployments = [{ id: "backup-new", status: "SUCCESS", createdAt: "now" }];
      }
      writeJSON(response, 200, {
        data: { deployments: { edges: deployments.map((node) => ({ node })) } },
      });
      return;
    }
    if (url.pathname === "/v9/projects/vercel-project") {
      writeJSON(response, 200, {
        targets: { production: { id: "vercel-anchor", url: "anchor.vercel.app" } },
      });
      return;
    }
    if (url.pathname.endsWith("/readyz")) {
      writeJSON(response, 200, { ready: true });
      return;
    }
    writeJSON(response, 404, { error: "not_found", path: url.pathname });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const fixture = `http://127.0.0.1:${address.port}`;
    const statePath = path.join(workspace, ".deploy-gate-state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        beforeSha: "77e73d10b7a1de172912dd15dd144ea13758e0c2",
        vercel: {
          anchorId: "vercel-anchor",
          anchorUrl: "anchor.vercel.app",
        },
        railway: {
          api: { anchorId: "api-anchor" },
          worker: { anchorId: "worker-anchor" },
          backup: { anchorId: null },
        },
        railwayDeployed: { backup: { id: "backup-new" } },
      }),
    );
    const success = await runGate(workspace, fixture, marker);
    if (success.code !== 0) throw new Error(`happy rollback failed:\n${success.output}`);
    if (!state.apiRedeployed || !state.workerRedeployed) {
      throw new Error("anchor redeploy was not requested for API and worker");
    }
    if (!existsSync(marker) || !readFileSync(marker, "utf8").includes("--service backup")) {
      throw new Error("first backup deployment was not removed precisely");
    }

    // A failed anchor redeploy plus an invalid rebuild SHA must make rollback
    // itself fail; swallowing this error would leave a red release looking
    // recovered in GitHub Actions.
    rmSync(marker, { force: true });
    state.failAPIRedeploy = true;
    state.apiRedeployed = false;
    state.workerRedeployed = false;
    writeFileSync(
      statePath,
      JSON.stringify({
        beforeSha: "invalid-sha",
        vercel: { anchorId: "vercel-anchor", anchorUrl: "anchor.vercel.app" },
        railway: {
          api: { anchorId: "api-anchor" },
          worker: { anchorId: "worker-anchor" },
          backup: { anchorId: null },
        },
      }),
    );
    const failure = await runGate(workspace, fixture, marker);
    if (failure.code === 0 || !failure.output.includes("rollback incomplete")) {
      throw new Error(`rollback failure was swallowed:\n${failure.output}`);
    }
    console.log("PASS deploy gate rollback terminal-state and failure propagation");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL deploy gate self-test: ${error.message}`);
  process.exitCode = 1;
});
