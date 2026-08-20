#!/usr/bin/env node
// Production deploy gate for the decoupled Vercel + Railway stack.
// See .github/workflows/deploy-production.yml for the orchestration contract.
//
// Subcommands: anchors | railway-deploy | vercel-wait | verdict | rollback
//
// State is shared between workflow steps through .deploy-gate-state.json in
// the workspace. Deploy steps never fail the job directly; they record
// ok=true/false and `verdict` is the single failure point, so a half-finished
// gate always reaches the rollback step.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const STATE_PATH = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), ".deploy-gate-state.json");
const selfTestEndpoint = (name, production) =>
  process.env.DEPLOY_GATE_SELFTEST === "1" && process.env[name]
    ? process.env[name]
    : production;
const RAILWAY_GQL = selfTestEndpoint(
  "DEPLOY_GATE_RAILWAY_GQL",
  "https://backboard.railway.app/graphql/v2",
);
const VERCEL_API = selfTestEndpoint("DEPLOY_GATE_VERCEL_API", "https://api.vercel.com");

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

function setOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${key}=${value}\n`);
  console.log(`[output] ${key}=${value}`);
}

async function railwayGql(query, variables) {
  const response = await fetch(RAILWAY_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Project-Access-Token": env("RAILWAY_TOKEN"),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(`railway graphql: ${JSON.stringify(body.errors)}`);
  return body.data;
}

async function vercelApi(pathname) {
  const org = env("VERCEL_ORG_ID");
  const separator = pathname.includes("?") ? "&" : "?";
  const response = await fetch(`${VERCEL_API}${pathname}${separator}teamId=${org}`, {
    headers: { Authorization: `Bearer ${env("VERCEL_TOKEN")}` },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`vercel api ${pathname}: ${JSON.stringify(body)}`);
  return body;
}

function vercelCli(args) {
  return execFileSync("vercel", [...args, "--token", env("VERCEL_TOKEN")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
  }).toString();
}

async function railwayDeployments(serviceId) {
  const data = await railwayGql(
    `query($input: DeploymentListInput!) {
       deployments(first: 20, input: $input) { edges { node { id status createdAt } } }
     }`,
    {
      input: {
        projectId: env("RAILWAY_PROJECT_ID"),
        environmentId: env("RAILWAY_ENVIRONMENT_ID"),
        serviceId,
      },
    },
  );
  return data.deployments.edges.map((edge) => edge.node);
}

async function railwayLatestSuccess(serviceId) {
  const deployments = await railwayDeployments(serviceId);
  const ok = deployments.find((deployment) => deployment.status === "SUCCESS");
  if (!ok) throw new Error(`no SUCCESS deployment found for railway service ${serviceId}`);
  return ok;
}

async function railwayLatestSuccessOptional(serviceId) {
  const deployments = await railwayDeployments(serviceId);
  return deployments.find((deployment) => deployment.status === "SUCCESS") || null;
}

async function commandAnchors() {
  // workflow_dispatch runs have no event.before; the previous main commit is
  // the first parent of the merge at HEAD.
  const beforeSha =
    process.env.BEFORE_SHA ||
    execFileSync("git", ["rev-parse", "HEAD~1"]).toString().trim();
  const currentSha = process.env.DEPLOY_SHA || env("GITHUB_SHA");

  // Staleness guard: queued runs execute FIFO, so an older run can start
  // after a newer main push already deployed. Deploying this run's older
  // commit last would silently roll the backend back — skip instead.
  const remoteHead = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"])
    .toString()
    .split(/\s+/)[0];
  if (remoteHead && remoteHead !== currentSha) {
    console.log(`stale run: this sha ${currentSha} is not main head ${remoteHead}; skipping gate`);
    writeState({ stale: true });
    setOutput("stale", "true");
    return;
  }
  setOutput("stale", "false");

  // Vercel anchor: the READY production deployment of the previous main
  // commit. Fallback: newest READY production deployment that is not this sha.
  const project = env("VERCEL_PROJECT_ID");
  const list = await vercelApi(`/v6/deployments?projectId=${project}&target=production&limit=20`);
  const ready = (list.deployments || []).filter(
    (deployment) => (deployment.readyState || deployment.state) === "READY",
  );
  const anchor =
    ready.find((deployment) => deployment.meta?.githubCommitSha === beforeSha) ||
    ready.find((deployment) => deployment.meta?.githubCommitSha !== currentSha);
  if (!anchor) throw new Error("no READY Vercel production deployment to anchor on");

  const apiAnchor = await railwayLatestSuccess(env("RAILWAY_API_SERVICE"));
  const workerAnchor = await railwayLatestSuccess(env("RAILWAY_WORKER_SERVICE"));
  // The Hobby-compatible backup cron is introduced by this release and may
  // legitimately have no prior deployment. Its first deployment is recorded
  // later so rollback can remove exactly that deployment instead of blocking
  // the whole gate before migration starts.
  const backupAnchor = await railwayLatestSuccessOptional(env("RAILWAY_BACKUP_SERVICE"));

  writeState({
    beforeSha,
    vercel: { anchorId: anchor.uid, anchorUrl: anchor.url, anchorSha: anchor.meta?.githubCommitSha },
    railway: {
      api: { anchorId: apiAnchor.id },
      worker: { anchorId: workerAnchor.id },
      backup: { anchorId: backupAnchor?.id || null },
    },
  });
  console.log(
    `anchors: vercel=${anchor.url} (${anchor.meta?.githubCommitSha}) railway-api=${apiAnchor.id} railway-worker=${workerAnchor.id} railway-backup=${backupAnchor?.id || "none"} before=${beforeSha}`,
  );
}

function railwayUp(serviceId) {
  const args = ["up", "--service", serviceId, "--environment", "production", "--ci", "-y"];
  try {
    execFileSync("railway", args, { stdio: "inherit", env: process.env });
  } catch (first) {
    // The CLI's built-in upload retry gives up after ~5 attempts; a Railway
    // control-plane 503 can outlast that. One full retry absorbs it without
    // masking persistent failures.
    console.error(`railway up for ${serviceId} failed (${first.message}); retrying once in 30s`);
    execFileSync("sleep", ["30"]);
    execFileSync("railway", args, { stdio: "inherit", env: process.env });
  }
}

async function waitRailwaySuccess(serviceId, previousId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployments = await railwayDeployments(serviceId);
    const latest = deployments[0];
    if (latest && latest.id !== previousId) {
      if (latest.status === "SUCCESS") return latest;
      if (["FAILED", "CRASHED", "REMOVED"].includes(latest.status)) {
        throw new Error(`railway deployment ${latest.id} for ${serviceId} reached ${latest.status}`);
      }
    }
    await sleep(20000);
  }
  throw new Error(`timeout waiting for railway service ${serviceId} deployment`);
}

async function waitRailwayDeployment(serviceId, deploymentId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployments = await railwayDeployments(serviceId);
    const deployment = deployments.find((candidate) => candidate.id === deploymentId);
    if (deployment?.status === "SUCCESS") return deployment;
    if (deployment && ["FAILED", "CRASHED", "REMOVED"].includes(deployment.status)) {
      throw new Error(
        `railway deployment ${deployment.id} for ${serviceId} reached ${deployment.status}`,
      );
    }
    await sleep(20000);
  }
  throw new Error(`timeout waiting for railway deployment ${deploymentId} on ${serviceId}`);
}

async function waitRailwayRemoved(serviceId, deploymentId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployments = await railwayDeployments(serviceId);
    const deployment = deployments.find((candidate) => candidate.id === deploymentId);
    if (!deployment || deployment.status === "REMOVED") return;
    await sleep(10000);
  }
  throw new Error(`timeout waiting for railway deployment ${deploymentId} removal on ${serviceId}`);
}

async function commandRailwayDeploy() {
  const services = [
    // Migrations are forward-only and are never rolled back. This one-shot
    // deployment must finish before either long-lived process can open Feed
    // PostgreSQL with FEED_MODE enabled.
    ["migrate", env("RAILWAY_MIGRATE_SERVICE")],
    ["api", env("RAILWAY_API_SERVICE")],
    ["worker", env("RAILWAY_WORKER_SERVICE")],
    // The cron deployment only builds and registers the schedule; it does not
    // block this gate until the next six-hour execution. Its actual backup
    // health is monitored separately via completed manifests.
    ["backup", env("RAILWAY_BACKUP_SERVICE")],
  ];
  try {
    for (const [name, serviceId] of services) {
      // Capture the latest deployment immediately before upload. In
      // particular, a one-shot migration service keeps old SUCCESS records;
      // accepting one of those during control-plane propagation would let API
      // rollout race ahead of the migration that belongs to this revision.
      const previousId = (await railwayDeployments(serviceId))[0]?.id;
      console.log(`deploying railway service ${name} (${serviceId})`);
      railwayUp(serviceId);
      const deployment = await waitRailwaySuccess(serviceId, previousId, 20 * 60 * 1000);
      const state = readState();
      writeState({
        railwayDeployed: {
          ...(state.railwayDeployed || {}),
          [name]: { id: deployment.id },
        },
      });
      console.log(`railway ${name} deployment ${deployment.id} SUCCESS`);
    }
    await verifyRailwayBackend();
    writeState({ railwayOk: true });
    setOutput("ok", "true");
  } catch (error) {
    console.error(`railway deploy failed: ${error.message}`);
    writeState({ railwayOk: false });
    setOutput("ok", "false");
  }
}

async function waitForHTTP(url, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      lastStatus = response.status;
      if (response.status === expectedStatus) return response;
    } catch {
      // The next attempt records the useful state; transient rollout resets
      // are expected while Railway swaps replicas.
    }
    await sleep(5000);
  }
  throw new Error(`${url} did not reach HTTP ${expectedStatus}; last status=${lastStatus}`);
}

async function verifyRailwayBackend() {
  const apiOrigin = env("RAILWAY_API_ORIGIN").replace(/\/$/, "");
  const workerOrigin = env("RAILWAY_WORKER_ORIGIN").replace(/\/$/, "");
  await waitForHTTP(`${apiOrigin}/readyz`, 200, 5 * 60 * 1000);
  await waitForHTTP(`${workerOrigin}/readyz`, 200, 5 * 60 * 1000);
  // Feed is deliberately absent from global readiness so its datastore can
  // fail without taking legacy APIs or core workers offline. A release is
  // nevertheless allowed through only when both Feed processes can reach the
  // migrated schema.
  await waitForHTTP(`${apiOrigin}/feed-readyz`, 200, 5 * 60 * 1000);
  await waitForHTTP(`${workerOrigin}/feed-readyz`, 200, 5 * 60 * 1000);
  const feed = await waitForHTTP(`${apiOrigin}/api/feed/tags`, 401, 60 * 1000);
  const body = await feed.json().catch(() => ({}));
  if (body.error !== "authentication_required") {
    throw new Error(`Feed auth contract mismatch: ${JSON.stringify(body)}`);
  }
  console.log("railway core readiness, Feed readiness, and Feed authentication are green");
}

async function commandVercelWait() {
  const currentSha = process.env.DEPLOY_SHA || env("GITHUB_SHA");
  const project = env("VERCEL_PROJECT_ID");
  // vercel.json disables Git-triggered production deployments for main. Only
  // this post-CI gate may publish the checked-out revision, which prevents a
  // failing commit from reaching Vercel while Railway is still gated on CI.
  try {
    vercelCli(["link", "--yes", "--project", project]);
    const output = vercelCli([
      "deploy",
      "--prod",
      "--yes",
      "--meta",
      `githubCommitSha=${currentSha}`,
      "--meta",
      "githubCommitRef=main",
    ]);
    const deploymentURL = output
      .trim()
      .split(/\s+/)
      .reverse()
      .find((value) => /^https:\/\//.test(value));
    if (!deploymentURL) throw new Error(`Vercel CLI returned no deployment URL: ${output}`);
    const hostname = new URL(deploymentURL).hostname;
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      const list = await vercelApi(`/v6/deployments?projectId=${project}&limit=20`);
      const deployment = (list.deployments || []).find(
        (candidate) => candidate.url === hostname || candidate.meta?.githubCommitSha === currentSha,
      );
      if (deployment) {
        const status = deployment.readyState || deployment.state;
        if (status === "READY") {
          writeState({ vercelOk: true, vercelDeploymentUrl: deployment.url });
          setOutput("ok", "true");
          console.log(`vercel deployment ${deployment.url} READY`);
          return;
        }
        if (["ERROR", "CANCELED"].includes(status)) {
          throw new Error(`vercel deployment ${deployment.url} reached ${status}`);
        }
      }
      await sleep(10000);
    }
    throw new Error("timeout waiting for the explicit Vercel production deployment");
  } catch (error) {
    console.error(`vercel wait failed: ${error.message}`);
    writeState({ vercelOk: false });
    setOutput("ok", "false");
  }
}

async function commandVerdict() {
  const state = readState();
  if (state.stale) {
    console.log("stale run skipped by the anchors step; nothing to gate");
    setOutput("rollback", "none");
    return;
  }
  const smokeOutcome = process.env.SMOKE_OUTCOME || "skipped";
  const problems = [];
  if (state.railwayOk !== true) problems.push("railway deploy not green");
  if (state.vercelOk !== true) problems.push("vercel deploy not green");
  if (smokeOutcome !== "success") problems.push(`smoke outcome=${smokeOutcome}`);
  if (problems.length === 0) {
    console.log("gate green: railway + vercel + smoke all ok");
    setOutput("rollback", "none");
    return;
  }
  console.error(`gate failed: ${problems.join("; ")}`);
  setOutput("rollback", "needed");
  process.exit(1);
}

async function vercelCurrentProduction() {
  const project = await vercelApi(`/v9/projects/${env("VERCEL_PROJECT_ID")}`);
  const production = project.targets?.production;
  return production ? { id: production.id, url: production.url } : null;
}

async function rollbackVercel(anchor) {
  const current = await vercelCurrentProduction();
  if (current && current.id === anchor.anchorId) {
    console.log("vercel production already on the anchor deployment, skip");
    return;
  }
  console.log(`rolling vercel back to ${anchor.anchorUrl}`);
  vercelCli(["link", "--yes", "--project", env("VERCEL_PROJECT_ID")]);
  vercelCli(["rollback", anchor.anchorUrl, "--yes", "--timeout", "10m"]);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const production = await vercelCurrentProduction();
    if (
      production &&
      (production.id === anchor.anchorId || production.url === anchor.anchorUrl)
    ) {
      console.log(`vercel production verified on anchor ${anchor.anchorId}`);
      return;
    }
    await sleep(10000);
  }
  throw new Error(`vercel production did not return to anchor ${anchor.anchorId}`);
}

async function removeFirstRailwayDeployment(name, serviceId, deployedId) {
  if (!deployedId) {
    console.log(`railway ${name} has no anchor and was not deployed by this gate, skip`);
    return;
  }
  const deployments = await railwayDeployments(serviceId);
  const latest = deployments[0];
  if (!latest || latest.status === "REMOVED") {
    console.log(`railway ${name} first deployment is already removed, skip`);
    return;
  }
  if (latest.id !== deployedId) {
    throw new Error(
      `refusing to remove railway ${name}: latest ${latest.id} is not gate deployment ${deployedId}`,
    );
  }
  execFileSync(
    "railway",
    [
      "down",
      "--service",
      serviceId,
      "--environment",
      "production",
      "--project",
      env("RAILWAY_PROJECT_ID"),
      "--yes",
    ],
    { stdio: "inherit", env: process.env },
  );
  await waitRailwayRemoved(serviceId, deployedId, 5 * 60 * 1000);
  console.log(`railway ${name} first deployment ${deployedId} removed`);
}

async function rollbackRailwayService(name, serviceId, anchorId, deployedId, beforeSha) {
  if (!anchorId) {
    await removeFirstRailwayDeployment(name, serviceId, deployedId);
    return;
  }
  const deployments = await railwayDeployments(serviceId);
  const latest = deployments[0];
  if (latest && latest.id === anchorId && latest.status === "SUCCESS") {
    console.log(`railway ${name} already on the anchor deployment, skip`);
    return;
  }
  try {
    const result = await railwayGql(
      `mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }`,
      { id: anchorId },
    );
    const redeploymentId = result.deploymentRedeploy?.id;
    if (!redeploymentId) throw new Error("deploymentRedeploy returned no deployment id");
    console.log(
      `railway ${name} redeploying anchor ${anchorId} as deployment ${redeploymentId}`,
    );
    await waitRailwayDeployment(serviceId, redeploymentId, 20 * 60 * 1000);
    console.log(`railway ${name} rollback deployment ${redeploymentId} SUCCESS`);
    return;
  } catch (error) {
    console.error(`railway ${name} anchor redeploy unavailable: ${error.message}`);
  }
  // Fallback: rebuild the previous main commit into the service. Only viable
  // when that commit still ships the backend image definition.
  if (!/^[0-9a-f]{40}$/i.test(beforeSha)) {
    throw new Error(`invalid rollback commit ${beforeSha}`);
  }
  const dockerfile = name === "backup" ? "Dockerfile.feed-backup" : "Dockerfile.backend";
  try {
    execFileSync("git", ["cat-file", "-e", `${beforeSha}:${dockerfile}`]);
  } catch {
    throw new Error(
      `railway ${name}: ${beforeSha} has no ${dockerfile}; cannot rebuild rollback anchor ${anchorId}`,
    );
  }
  const worktree = mkdtempSync(path.join(tmpdir(), `ghfind-rollback-${name}-`));
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, beforeSha], {
      stdio: "inherit",
    });
    const previousId = (await railwayDeployments(serviceId))[0]?.id;
    console.log(`railway ${name}: rebuilding ${beforeSha} as the rollback deployment`);
    execFileSync(
      "railway",
      ["up", worktree, "--service", serviceId, "--environment", "production", "--ci", "-y"],
      { stdio: "inherit", env: process.env },
    );
    const rollback = await waitRailwaySuccess(serviceId, previousId, 20 * 60 * 1000);
    console.log(`railway ${name} rebuilt rollback deployment ${rollback.id} SUCCESS`);
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree]);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

async function commandRollback() {
  const state = readState();
  if (!state.vercel || !state.railway) {
    throw new Error("no anchors captured; refusing to report a successful rollback");
  }
  const failures = [];
  try {
    await rollbackVercel(state.vercel);
  } catch (error) {
    console.error(`vercel rollback failed: ${error.message}`);
    failures.push(`vercel: ${error.message}`);
  }
  await Promise.all(
    [
    ["api", env("RAILWAY_API_SERVICE")],
    ["worker", env("RAILWAY_WORKER_SERVICE")],
    ["backup", env("RAILWAY_BACKUP_SERVICE")],
    ].map(async ([name, serviceId]) => {
      try {
        await rollbackRailwayService(
          name,
          serviceId,
          state.railway[name].anchorId,
          state.railwayDeployed?.[name]?.id,
          state.beforeSha,
        );
      } catch (error) {
        console.error(`railway ${name} rollback failed: ${error.message}`);
        failures.push(`railway ${name}: ${error.message}`);
      }
    }),
  );
  // Rollback anchors predate /feed-readyz, so rollback health intentionally
  // verifies only the original core contract. Feed migrations are forward-only
  // and backward-compatible.
  try {
    const apiOrigin = env("RAILWAY_API_ORIGIN").replace(/\/$/, "");
    const workerOrigin = env("RAILWAY_WORKER_ORIGIN").replace(/\/$/, "");
    await waitForHTTP(`${apiOrigin}/readyz`, 200, 5 * 60 * 1000);
    await waitForHTTP(`${workerOrigin}/readyz`, 200, 5 * 60 * 1000);
  } catch (error) {
    failures.push(`post-rollback core readiness: ${error.message}`);
  }
  if (failures.length > 0) {
    throw new Error(`rollback incomplete: ${failures.join("; ")}`);
  }
  console.log("rollback verified: Vercel anchor and Railway core readiness are green");
}

const [, , command] = process.argv;
const commands = {
  anchors: commandAnchors,
  "railway-deploy": commandRailwayDeploy,
  "vercel-wait": commandVercelWait,
  verdict: commandVerdict,
  rollback: commandRollback,
};

if (!commands[command]) {
  console.error(`unknown command ${command}; expected one of ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}

commands[command]().catch((error) => {
  console.error(error);
  process.exit(1);
});
