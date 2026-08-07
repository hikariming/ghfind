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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const STATE_PATH = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), ".deploy-gate-state.json");
const RAILWAY_GQL = "https://backboard.railway.app/graphql/v2";
const VERCEL_API = "https://api.vercel.com";

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
  if (out) execFileSync("bash", ["-c", `echo "${key}=${value}" >> "$GITHUB_OUTPUT"`]);
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
       deployments(first: 5, input: $input) { edges { node { id status createdAt } } }
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

async function commandAnchors() {
  // workflow_dispatch runs have no event.before; the previous main commit is
  // the first parent of the merge at HEAD.
  const beforeSha =
    process.env.BEFORE_SHA ||
    execFileSync("git", ["rev-parse", "HEAD~1"]).toString().trim();
  const currentSha = env("GITHUB_SHA");

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

  writeState({
    beforeSha,
    vercel: { anchorId: anchor.uid, anchorUrl: anchor.url, anchorSha: anchor.meta?.githubCommitSha },
    railway: {
      api: { anchorId: apiAnchor.id },
      worker: { anchorId: workerAnchor.id },
    },
  });
  console.log(
    `anchors: vercel=${anchor.url} (${anchor.meta?.githubCommitSha}) railway-api=${apiAnchor.id} railway-worker=${workerAnchor.id} before=${beforeSha}`,
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

async function commandRailwayDeploy() {
  const state = readState();
  const services = [
    ["api", env("RAILWAY_API_SERVICE")],
    ["worker", env("RAILWAY_WORKER_SERVICE")],
  ];
  try {
    for (const [name, serviceId] of services) {
      const previousId = state.railway?.[name]?.anchorId;
      console.log(`deploying railway service ${name} (${serviceId})`);
      railwayUp(serviceId);
      const deployment = await waitRailwaySuccess(serviceId, previousId, 30 * 60 * 1000);
      console.log(`railway ${name} deployment ${deployment.id} SUCCESS`);
    }
    writeState({ railwayOk: true });
    setOutput("ok", "true");
  } catch (error) {
    console.error(`railway deploy failed: ${error.message}`);
    writeState({ railwayOk: false });
    setOutput("ok", "false");
  }
}

async function commandVercelWait() {
  const currentSha = env("GITHUB_SHA");
  const project = env("VERCEL_PROJECT_ID");
  const deadline = Date.now() + 25 * 60 * 1000;
  try {
    for (;;) {
      const list = await vercelApi(`/v6/deployments?projectId=${project}&limit=20`);
      const deployment = (list.deployments || []).find(
        (candidate) => candidate.meta?.githubCommitSha === currentSha,
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
      if (Date.now() > deadline) throw new Error("timeout waiting for the vercel deployment");
      await sleep(20000);
    }
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
}

async function rollbackRailwayService(name, serviceId, anchorId, beforeSha) {
  const deployments = await railwayDeployments(serviceId);
  const latest = deployments[0];
  if (latest && latest.id === anchorId && latest.status === "SUCCESS") {
    console.log(`railway ${name} already on the anchor deployment, skip`);
    return;
  }
  try {
    await railwayGql(
      `mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }`,
      { id: anchorId },
    );
    console.log(`railway ${name} redeployed anchor deployment ${anchorId}`);
    return;
  } catch (error) {
    console.error(`railway ${name} anchor redeploy unavailable: ${error.message}`);
  }
  // Fallback: rebuild the previous main commit into the service. Only viable
  // when that commit still ships the backend image definition.
  const probe = execFileSync(
    "bash",
    ["-c", `git cat-file -e ${beforeSha}:Dockerfile.backend && echo yes || echo no`],
  )
    .toString()
    .trim();
  if (probe !== "yes") {
    console.error(
      `railway ${name}: ${beforeSha} has no Dockerfile.backend; manual rollback of service ${serviceId} to deployment ${anchorId} required`,
    );
    return;
  }
  const worktree = `/tmp/ghfind-rollback-${name}`;
  execFileSync("bash", [
    "-c",
    `git worktree remove --force ${worktree} 2>/dev/null; git worktree add ${worktree} ${beforeSha}`,
  ]);
  console.log(`railway ${name}: rebuilding ${beforeSha} as the rollback deployment`);
  execFileSync(
    "railway",
    ["up", worktree, "--service", serviceId, "--environment", "production", "--ci", "-y"],
    { stdio: "inherit", env: process.env },
  );
}

async function commandRollback() {
  const state = readState();
  if (!state.vercel || !state.railway) {
    console.error("no anchors captured; nothing safe to roll back automatically");
    return;
  }
  try {
    await rollbackVercel(state.vercel);
  } catch (error) {
    console.error(`vercel rollback failed: ${error.message}`);
  }
  for (const [name, serviceId] of [
    ["api", env("RAILWAY_API_SERVICE")],
    ["worker", env("RAILWAY_WORKER_SERVICE")],
  ]) {
    try {
      await rollbackRailwayService(name, serviceId, state.railway[name].anchorId, state.beforeSha);
    } catch (error) {
      console.error(`railway ${name} rollback failed: ${error.message}`);
    }
  }
  console.log("rollback pass finished; verify ghfind.com and railway readiness before re-merging");
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
