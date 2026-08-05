import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type QueueFixture = {
  name: string;
  kind: string;
  role: string;
  arguments: Record<string, string>;
};

const QUEUES: QueueFixture[] = [
  {
    name: "ghfind.scan.quick.v1",
    kind: "scan.quick.v1",
    role: "primary",
    arguments: {
      "x-dead-letter-exchange": "ghfind.jobs.dlx.v1",
      "x-dead-letter-routing-key": "scan.quick.dead.v1",
    },
  },
  {
    name: "ghfind.scan.quick.retry.v1",
    kind: "scan.quick.v1",
    role: "retry",
    arguments: {
      "x-dead-letter-exchange": "ghfind.jobs.v1",
      "x-dead-letter-routing-key": "scan.quick.v1",
    },
  },
  { name: "ghfind.scan.quick.dead.v1", kind: "scan.quick.v1", role: "dead", arguments: {} },
  {
    name: "ghfind.score-snapshot.v1",
    kind: "score_snapshot.v1",
    role: "primary",
    arguments: {
      "x-dead-letter-exchange": "ghfind.jobs.dlx.v1",
      "x-dead-letter-routing-key": "score.snapshot.dead.v1",
    },
  },
  {
    name: "ghfind.score-snapshot.retry.v1",
    kind: "score_snapshot.v1",
    role: "retry",
    arguments: {
      "x-dead-letter-exchange": "ghfind.jobs.v1",
      "x-dead-letter-routing-key": "score.snapshot.v1",
    },
  },
  { name: "ghfind.score-snapshot.dead.v1", kind: "score_snapshot.v1", role: "dead", arguments: {} },
  {
    name: "ghfind.project-analysis.v1",
    kind: "project-analysis.v1",
    role: "primary",
    arguments: {
      "x-dead-letter-exchange": "ghfind.jobs.dlx.v1",
      "x-dead-letter-routing-key": "project-analysis.dead.v1",
    },
  },
  {
    name: "ghfind.project-analysis.retry.v1",
    kind: "project-analysis.v1",
    role: "retry",
    arguments: {
      "x-dead-letter-exchange": "ghfind.jobs.v1",
      "x-dead-letter-routing-key": "project-analysis.v1",
    },
  },
  { name: "ghfind.project-analysis.dead.v1", kind: "project-analysis.v1", role: "dead", arguments: {} },
];

function writeJSON(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function startServer(handler: http.RequestListener): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

function backendHandler(request: http.IncomingMessage, response: http.ServerResponse): void {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJSON(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    writeJSON(response, 200, { ready: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      [
        '# TYPE ghfind_api_job_admissions_total counter',
        'ghfind_api_job_admissions_total{kind="scan.quick.v1",result="queued"} 3',
        '# TYPE ghfind_api_scan_waits_total counter',
        'ghfind_api_scan_waits_total{result="completed"} 2',
        "",
      ].join("\n"),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/scan/jobs/job_restart_001") {
    writeJSON(response, 200, {
      status: { id: "job_restart_001", kind: "scan.quick.v1", username: "octocat", state: "completed", attempt: 2 },
      result: { metrics: { username: "octocat" }, scoring: { final_score: 42 } },
    });
    return;
  }
  writeJSON(response, 404, { error: "not_found" });
}

function workerHandler(request: http.IncomingMessage, response: http.ServerResponse): void {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (request.method === "GET" && url.pathname === "/metrics") {
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      [
        '# TYPE ghfind_worker_jobs_started_total counter',
        'ghfind_worker_jobs_started_total{kind="scan.quick.v1"} 4',
        '# TYPE ghfind_worker_jobs_completed_total counter',
        'ghfind_worker_jobs_completed_total{kind="scan.quick.v1",result="created"} 2',
        '# TYPE ghfind_worker_jobs_retried_total counter',
        'ghfind_worker_jobs_retried_total{kind="scan.quick.v1"} 1',
        '# TYPE ghfind_worker_jobs_dead_lettered_total counter',
        'ghfind_worker_jobs_dead_lettered_total{kind="scan.quick.v1"} 1',
        '# TYPE ghfind_worker_job_duration_seconds_count counter',
        'ghfind_worker_job_duration_seconds_count{kind="scan.quick.v1"} 4',
        "",
      ].join("\n"),
    );
    return;
  }
  writeJSON(response, 404, { error: "not_found" });
}

function rabbitHandler(request: http.IncomingMessage, response: http.ServerResponse): void {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const expectedAuth = `Basic ${Buffer.from("rabbit:rabbit-secret").toString("base64")}`;
  if (request.headers.authorization !== expectedAuth) {
    writeJSON(response, 401, { error: "unauthorized" });
    return;
  }
  const parts = url.pathname.split("/");
  if (request.method !== "GET" || parts.length !== 5 || parts[1] !== "api" || parts[2] !== "queues") {
    writeJSON(response, 404, { error: "not_found" });
    return;
  }
  const queueName = decodeURIComponent(parts[4] ?? "");
  const queue = QUEUES.find((candidate) => candidate.name === queueName);
  if (!queue) {
    writeJSON(response, 404, { error: "missing_queue" });
    return;
  }
  writeJSON(response, 200, {
    name: queue.name,
    durable: true,
    auto_delete: false,
    arguments: queue.arguments,
    messages: queue.role === "dead" && queue.kind === "scan.quick.v1" ? 1 : 0,
    messages_ready: queue.role === "dead" && queue.kind === "scan.quick.v1" ? 1 : 0,
    messages_unacknowledged: 0,
    consumers: queue.role === "primary" ? 1 : 0,
    state: "running",
  });
}

async function runSmoke(origins: { backend: string; worker: string; rabbit: string }, outputPath: string): Promise<void> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["smoke:backend:resilience"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      SMOKE_ALLOW_HTTP: "1",
      SMOKE_BASE_URL: origins.backend,
      SMOKE_BACKEND_BASE_URL: origins.backend,
      SMOKE_WORKER_METRICS_BASE_URL: origins.worker,
      SMOKE_RABBITMQ_MANAGEMENT_URL: origins.rabbit,
      SMOKE_RABBITMQ_MANAGEMENT_USER: "rabbit",
      SMOKE_RABBITMQ_MANAGEMENT_PASSWORD: "rabbit-secret",
      SMOKE_REQUIRE_RETRY_EVIDENCE: "1",
      SMOKE_REQUIRE_DLQ_EVIDENCE: "1",
      SMOKE_REQUIRE_EMPTY_ACTIVE_QUEUES: "1",
      SMOKE_REQUIRE_RESTART_EVIDENCE: "1",
      SMOKE_RESTART_JOB_ID: "job_restart_001",
      SMOKE_RESTART_USERNAME: "octocat",
      SMOKE_RESTART_EXPECT_RESULT: "1",
      SMOKE_WORKER_DEPLOYMENT_BEFORE: "worker-before",
      SMOKE_WORKER_DEPLOYMENT_AFTER: "worker-after",
      SMOKE_REQUIRE_DEPLOYMENT_ANCHORS: "1",
      SMOKE_VERCEL_DEPLOYMENT_ID: "vercel-current",
      SMOKE_RAILWAY_API_DEPLOYMENT_ID: "api-current",
      SMOKE_RAILWAY_WORKER_DEPLOYMENT_ID: "worker-current",
      SMOKE_RABBITMQ_VOLUME_ID: "rabbitmq-volume",
      SMOKE_REQUIRE_ROLLBACK_EVIDENCE: "1",
      SMOKE_ROLLBACK_MODE: "railway",
      SMOKE_ROLLBACK_FROM_DEPLOYMENT_ID: "worker-bad",
      SMOKE_ROLLBACK_TO_DEPLOYMENT_ID: "worker-good",
      SMOKE_ROLLBACK_VERIFIED_AT: "2026-08-04T00:00:00Z",
      SMOKE_EVIDENCE_OUTPUT: outputPath,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`backend resilience smoke self-test exited with ${code ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  const backend = await startServer(backendHandler);
  const worker = await startServer(workerHandler);
  const rabbit = await startServer(rabbitHandler);
  const temp = await mkdtemp(join(tmpdir(), "ghfind-resilience-"));
  const outputPath = join(temp, "evidence.json");
  try {
    await runSmoke({ backend: backend.origin, worker: worker.origin, rabbit: rabbit.origin }, outputPath);
    const evidence = JSON.parse(await readFile(outputPath, "utf8")) as {
      queues?: unknown[];
      restartJob?: { state?: string };
      rollback?: { mode?: string };
    };
    if (evidence.queues?.length !== 9) {
      throw new Error("self-test evidence did not record all RabbitMQ queues");
    }
    if (evidence.restartJob?.state !== "completed") {
      throw new Error("self-test evidence did not record restart completion");
    }
    if (evidence.rollback?.mode !== "railway") {
      throw new Error("self-test evidence did not record rollback anchors");
    }
  } finally {
    await Promise.all([backend.close(), worker.close(), rabbit.close()]);
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`FAIL backend resilience smoke self-test: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
