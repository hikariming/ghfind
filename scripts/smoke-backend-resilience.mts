import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const REQUEST_TIMEOUT_MS = 15_000;

const QUEUES = [
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
] as const;

type QueueDefinition = (typeof QUEUES)[number];

type QueueEvidence = {
  name: string;
  kind: string;
  role: string;
  durable: boolean;
  messages: number;
  messagesReady: number;
  messagesUnacknowledged: number;
  consumers: number;
  state: string;
};

type ScanJobEvidence = {
  id: string;
  kind: string;
  state: string;
  attempt: number | null;
  hasResult: boolean;
};

function usage(): void {
  console.log("Run with private SMOKE_* variables; see docs/releases/deployment-smoke.md");
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function flag(name: string): boolean {
  return process.env[name] === "1";
}

function record(value: unknown, label = "response"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function numberField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`RabbitMQ queue field ${name} is not a finite number`);
  }
  return value;
}

function originUrl(name: string, requiredValue: boolean): URL | null {
  const raw = requiredValue ? required(name) : optional(name);
  if (!raw) return null;
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must contain only an origin; put credentials in separate variables`);
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    if (!flag("SMOKE_ALLOW_HTTP")) throw new Error("localhost smoke requires SMOKE_ALLOW_HTTP=1");
  } else if (url.protocol !== "https:") {
    throw new Error("remote backend resilience smoke requires HTTPS");
  }
  url.pathname = "/";
  return url;
}

async function fetchJSON(url: URL, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${url.pathname} did not return JSON`);
  }
  return { response, body };
}

async function requireProcessHealth(base: URL): Promise<void> {
  const health = await fetchJSON(new URL("/healthz", base));
  if (health.response.status !== 200 || record(health.body).ok !== true) {
    throw new Error("backend health is not ok");
  }
  const readiness = await fetchJSON(new URL("/readyz", base));
  if (readiness.response.status !== 200 || record(readiness.body).ready !== true) {
    throw new Error("backend readiness is not ready");
  }
  console.log("PASS backend health/readiness");
}

async function fetchMetrics(base: URL, label: string): Promise<string> {
  const response = await fetch(new URL("/metrics", base), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: "text/plain" },
  });
  if (response.status !== 200) {
    throw new Error(`${label} metrics returned ${response.status}; expected 200`);
  }
  if (!(response.headers.get("content-type") ?? "").includes("text/plain")) {
    throw new Error(`${label} metrics did not return text/plain`);
  }
  if (response.headers.get("cache-control") !== "no-store") {
    throw new Error(`${label} metrics must be no-store`);
  }
  const text = await response.text();
  console.log(`PASS ${label} metrics`);
  return text;
}

function metricSamples(text: string, name: string, labels: Record<string, string> = {}): number[] {
  const samples: number[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `))) {
      continue;
    }
    let matches = true;
    for (const [key, value] of Object.entries(labels)) {
      if (!line.includes(`${key}="${value}"`)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const raw = line.trim().split(/\s+/).at(-1);
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) samples.push(parsed);
  }
  return samples;
}

function metricTotal(text: string, name: string, labels: Record<string, string> = {}): number {
  return metricSamples(text, name, labels).reduce((sum, value) => sum + value, 0);
}

function metricTotals(text: string, names: string[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const name of names) totals[name] = metricTotal(text, name);
  return totals;
}

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${required("SMOKE_RABBITMQ_MANAGEMENT_USER")}:${required("SMOKE_RABBITMQ_MANAGEMENT_PASSWORD")}`).toString("base64")}`;
}

async function fetchQueue(base: URL, vhost: string, definition: QueueDefinition, authHeader: string): Promise<QueueEvidence> {
  const url = new URL(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(definition.name)}`, base);
  const { response, body } = await fetchJSON(url, { headers: { Authorization: authHeader } });
  if (response.status !== 200) {
    throw new Error(`RabbitMQ queue ${definition.name} returned ${response.status}; expected 200`);
  }
  const payload = record(body, `RabbitMQ queue ${definition.name}`);
  if (payload.name !== definition.name) {
    throw new Error(`RabbitMQ queue ${definition.name} returned the wrong name`);
  }
  if (payload.durable !== true) {
    throw new Error(`RabbitMQ queue ${definition.name} is not durable`);
  }
  const args = record(payload.arguments ?? {}, `RabbitMQ queue ${definition.name} arguments`);
  for (const [key, value] of Object.entries(definition.arguments)) {
    if (args[key] !== value) {
      throw new Error(`RabbitMQ queue ${definition.name} is missing ${key}=${value}`);
    }
  }
  return {
    name: definition.name,
    kind: definition.kind,
    role: definition.role,
    durable: true,
    messages: numberField(payload, "messages"),
    messagesReady: numberField(payload, "messages_ready"),
    messagesUnacknowledged: numberField(payload, "messages_unacknowledged"),
    consumers: numberField(payload, "consumers"),
    state: String(payload.state ?? ""),
  };
}

async function fetchQueues(base: URL): Promise<QueueEvidence[]> {
  const vhost = optional("SMOKE_RABBITMQ_VHOST") ?? "/";
  const authHeader = basicAuthHeader();
  const queues: QueueEvidence[] = [];
  for (const definition of QUEUES) {
    queues.push(await fetchQueue(base, vhost, definition, authHeader));
  }
  console.log("PASS RabbitMQ durable topology");
  return queues;
}

function queueFor(queues: QueueEvidence[], kind: string, role: string): QueueEvidence {
  const queue = queues.find((candidate) => candidate.kind === kind && candidate.role === role);
  if (!queue) throw new Error(`missing ${kind} ${role} queue evidence`);
  return queue;
}

function requireRetryEvidence(workerMetrics: string, queues: QueueEvidence[]): void {
  if (!flag("SMOKE_REQUIRE_RETRY_EVIDENCE")) return;
  const kind = optional("SMOKE_RETRY_KIND") ?? "scan.quick.v1";
  const retried = metricTotal(workerMetrics, "ghfind_worker_jobs_retried_total", { kind });
  const retryMessages = queueFor(queues, kind, "retry").messages;
  if (retried <= 0 && retryMessages <= 0) {
    throw new Error(`missing retry evidence for ${kind}`);
  }
  console.log("PASS retry evidence");
}

function requireDLQEvidence(workerMetrics: string, queues: QueueEvidence[]): void {
  if (!flag("SMOKE_REQUIRE_DLQ_EVIDENCE")) return;
  const kind = optional("SMOKE_DLQ_KIND") ?? "scan.quick.v1";
  const deadLettered = metricTotal(workerMetrics, "ghfind_worker_jobs_dead_lettered_total", { kind });
  const deadMessages = queueFor(queues, kind, "dead").messages;
  if (deadLettered <= 0 && deadMessages <= 0) {
    throw new Error(`missing DLQ evidence for ${kind}`);
  }
  console.log("PASS DLQ evidence");
}

function requireEmptyActiveQueues(queues: QueueEvidence[]): void {
  if (!flag("SMOKE_REQUIRE_EMPTY_ACTIVE_QUEUES")) return;
  const stuck = queues.filter((queue) => queue.role !== "dead" && queue.messages > 0);
  if (stuck.length > 0) {
    throw new Error(`active queues are not drained: ${stuck.map((queue) => queue.name).join(", ")}`);
  }
  console.log("PASS active queue drain");
}

async function fetchScanJob(base: URL, jobID: string, label: string): Promise<ScanJobEvidence> {
  const { response, body } = await fetchJSON(new URL(`/api/scan/jobs/${encodeURIComponent(jobID)}`, base));
  if (response.status !== 200) {
    throw new Error(`${label} scan job returned ${response.status}; expected 200`);
  }
  const payload = record(body);
  const status = record(payload.status);
  const state = String(status.state);
  if (!new Set(["queued", "running", "retrying", "completed", "failed"]).has(state)) {
    throw new Error(`${label} scan job returned an invalid state`);
  }
  const expectedUsername = optional(`SMOKE_${label.toUpperCase().replaceAll(" ", "_")}_USERNAME`);
  if (expectedUsername && String(status.username).toLowerCase() !== expectedUsername.toLowerCase()) {
    throw new Error(`${label} scan job returned the wrong username`);
  }
  const attempt = typeof status.attempt === "number" ? status.attempt : null;
  return {
    id: jobID,
    kind: String(status.kind),
    state,
    attempt,
    hasResult: Boolean(payload.result),
  };
}

async function requireRestartEvidence(base: URL | null): Promise<ScanJobEvidence | null> {
  if (!flag("SMOKE_REQUIRE_RESTART_EVIDENCE")) return null;
  if (!base) throw new Error("SMOKE_BASE_URL is required when SMOKE_REQUIRE_RESTART_EVIDENCE=1");
  const before = required("SMOKE_WORKER_DEPLOYMENT_BEFORE");
  const after = required("SMOKE_WORKER_DEPLOYMENT_AFTER");
  if (before === after) {
    throw new Error("SMOKE_WORKER_DEPLOYMENT_BEFORE and SMOKE_WORKER_DEPLOYMENT_AFTER must differ");
  }
  const job = await fetchScanJob(base, required("SMOKE_RESTART_JOB_ID"), "restart");
  if (job.state !== "completed" && job.state !== "failed") {
    throw new Error(`restart evidence job is ${job.state}, not terminal`);
  }
  if (flag("SMOKE_RESTART_EXPECT_RESULT") && !job.hasResult) {
    throw new Error("restart evidence job is missing result");
  }
  console.log("PASS restart recovery evidence");
  return job;
}

function requireDeploymentAnchors(): Record<string, string> | null {
  if (!flag("SMOKE_REQUIRE_DEPLOYMENT_ANCHORS")) return null;
  const anchors = {
    vercelDeployment: required("SMOKE_VERCEL_DEPLOYMENT_ID"),
    railwayApiDeployment: required("SMOKE_RAILWAY_API_DEPLOYMENT_ID"),
    railwayWorkerDeployment: required("SMOKE_RAILWAY_WORKER_DEPLOYMENT_ID"),
    rabbitmqVolume: required("SMOKE_RABBITMQ_VOLUME_ID"),
  };
  console.log("PASS deployment anchors");
  return anchors;
}

function requireRollbackEvidence(): Record<string, string> | null {
  if (!flag("SMOKE_REQUIRE_ROLLBACK_EVIDENCE")) return null;
  const mode = required("SMOKE_ROLLBACK_MODE");
  if (mode !== "railway" && mode !== "vercel") {
    throw new Error("SMOKE_ROLLBACK_MODE must be railway or vercel; fail-closed containment is not rollback evidence");
  }
  const from = required("SMOKE_ROLLBACK_FROM_DEPLOYMENT_ID");
  const to = required("SMOKE_ROLLBACK_TO_DEPLOYMENT_ID");
  if (from === to) {
    throw new Error("rollback from/to deployment IDs must differ");
  }
  const verifiedAt = required("SMOKE_ROLLBACK_VERIFIED_AT");
  console.log("PASS rollback anchors");
  return { mode, from, to, verifiedAt };
}

async function writeEvidence(path: string | null, evidence: Record<string, unknown>): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log("PASS evidence artifact written");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    usage();
    return;
  }

  const base = originUrl("SMOKE_BASE_URL", false);
  const backend = originUrl("SMOKE_BACKEND_BASE_URL", true);
  if (!backend) throw new Error("SMOKE_BACKEND_BASE_URL is required");
  const worker = originUrl("SMOKE_WORKER_METRICS_BASE_URL", true);
  if (!worker) throw new Error("SMOKE_WORKER_METRICS_BASE_URL is required");
  const rabbit = originUrl("SMOKE_RABBITMQ_MANAGEMENT_URL", true);
  if (!rabbit) throw new Error("SMOKE_RABBITMQ_MANAGEMENT_URL is required");

  await requireProcessHealth(backend);
  const apiMetrics = await fetchMetrics(backend, "backend");
  const workerMetrics = await fetchMetrics(worker, "worker");
  const queues = await fetchQueues(rabbit);
  requireRetryEvidence(workerMetrics, queues);
  requireDLQEvidence(workerMetrics, queues);
  requireEmptyActiveQueues(queues);
  const restartJob = await requireRestartEvidence(base);
  const deploymentAnchors = requireDeploymentAnchors();
  const rollback = requireRollbackEvidence();

  const evidence = {
    generatedAt: new Date().toISOString(),
    origins: {
      sameOrigin: base?.origin ?? null,
      backend: backend.origin,
      workerMetrics: worker.origin,
      rabbitManagement: rabbit.origin,
    },
    deploymentAnchors,
    rollback,
    restartJob,
    metrics: {
      backend: metricTotals(apiMetrics, ["ghfind_api_job_admissions_total", "ghfind_api_scan_waits_total"]),
      worker: metricTotals(workerMetrics, [
        "ghfind_worker_jobs_started_total",
        "ghfind_worker_jobs_completed_total",
        "ghfind_worker_jobs_retried_total",
        "ghfind_worker_jobs_failed_total",
        "ghfind_worker_jobs_dead_lettered_total",
        "ghfind_worker_job_duration_seconds_count",
      ]),
    },
    queues,
  };

  await writeEvidence(optional("SMOKE_EVIDENCE_OUTPUT"), evidence);
  console.log("PASS backend resilience smoke");
}

main().catch((error: unknown) => {
  console.error(`FAIL backend resilience smoke: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
