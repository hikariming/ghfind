import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

const username = "octocat";
const idempotencyKey = "async-selftest";
const jobID = `job_${createHash("sha256")
  .update(`scan.quick.v1\0${username}\0${idempotencyKey}`)
  .digest("hex")
  .slice(0, 32)}`;

function writeJSON(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  let admitted = false;
  const server = http.createServer((request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);

    if (request.method === "POST" && url.pathname === "/api/scan") {
      if (request.headers.authorization !== "Bearer machine-key") {
        writeJSON(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.headers["idempotency-key"] !== idempotencyKey) {
        writeJSON(response, 400, { error: "wrong_idempotency_key" });
        return;
      }
      admitted = true;
      writeJSON(
        response,
        202,
        { id: jobID, kind: "scan.quick.v1", username, state: "queued" },
        { location: `/api/scan/jobs/${jobID}`, "cache-control": "no-store" },
      );
      return;
    }

    if (request.method === "GET" && url.pathname === `/api/scan/jobs/${jobID}`) {
      if (!admitted) {
        writeJSON(response, 404, { error: "not_found" });
        return;
      }
      writeJSON(response, 200, {
        status: { id: jobID, kind: "scan.quick.v1", username, state: "completed" },
        result: { cached: false, metrics: { username }, scoring: { final_score: 42 } },
      });
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
          'ghfind_api_job_admissions_total{kind="scan.quick.v1",result="queued"} 1',
          '# TYPE ghfind_worker_jobs_completed_total counter',
          'ghfind_worker_jobs_completed_total{kind="scan.quick.v1",result="persisted"} 1',
          '# TYPE ghfind_worker_job_duration_seconds_count counter',
          'ghfind_worker_job_duration_seconds_count{kind="scan.quick.v1"} 1',
          "",
        ].join("\n"),
      );
      return;
    }

    writeJSON(response, 404, { error: "not_found", path: url.pathname });
  });

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

async function runSmoke(origin: string): Promise<void> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["smoke:backend:async"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      SMOKE_ALLOW_HTTP: "1",
      SMOKE_BASE_URL: origin,
      SMOKE_BACKEND_BASE_URL: origin,
      SMOKE_WORKER_METRICS_BASE_URL: origin,
      SMOKE_SCAN_USERNAME: username,
      SMOKE_MACHINE_API_KEY: "machine-key",
      SMOKE_IDEMPOTENCY_KEY: idempotencyKey,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`backend async smoke self-test exited with ${code ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  const fixture = await startFixtureServer();
  try {
    await runSmoke(fixture.origin);
  } finally {
    await fixture.close();
  }
}

main().catch((error: unknown) => {
  console.error(`FAIL backend async smoke self-test: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
