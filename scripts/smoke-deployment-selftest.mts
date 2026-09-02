import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

function writeJSON(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function writeText(response: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  response.writeHead(status, headers);
  response.end(body);
}

function startFixtureServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    const origin = `http://${host}`;

    if (request.method === "GET" && url.pathname === "/u/octocat") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html>octocat</html>");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/score/octocat") {
      writeJSON(response, 200, { username: "octocat", profile: `${origin}/u/octocat`, final_score: 42 });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/badge/octocat") {
      writeText(response, 200, "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>42</text></svg>", {
        "content-type": "image/svg+xml; charset=utf-8",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/search-users") {
      writeJSON(response, 200, { users: [{ username: "octocat" }] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/leaderboard") {
      writeJSON(response, 200, { entries: [{ username: "octocat" }] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/developers") {
      writeJSON(response, 200, { entries: [{ username: "octocat" }] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      writeJSON(response, 200, { projects: [] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sitemap") {
      writeJSON(response, 200, { profiles: [], matchups: [] });
      return;
    }
    if (request.method === "POST" && url.pathname === "/mcp") {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.end('data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"score_user"}]}}\n\n');
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/campaigns/advx/leaderboard/events") {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write("retry: 2000\n\n");
      setTimeout(() => response.end(), 50);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/scan/jobs/job_aaaaaaaaaaaaaaaa") {
      writeJSON(response, 200, {
        status: {
          id: "job_aaaaaaaaaaaaaaaa",
          kind: "scan.quick.v1",
          username: "octocat",
          state: "completed",
        },
        result: { metrics: { username: "octocat" }, scoring: { final_score: 42 } },
      });
      return;
    }
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
      response.end('# TYPE ghfind_api_job_admissions_total counter\n');
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
  const child = spawn(command, ["smoke:deployment"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      SMOKE_ALLOW_HTTP: "1",
      SMOKE_BASE_URL: origin,
      SMOKE_CANARY_HANDLE: "octocat",
      SMOKE_FACET_TYPE: "language",
      SMOKE_FACET_VALUE: "TypeScript",
      SMOKE_SCAN_JOB_ID: "job_aaaaaaaaaaaaaaaa",
      SMOKE_SCAN_JOB_USERNAME: "octocat",
      SMOKE_SCAN_JOB_EXPECT_RESULT: "1",
      SMOKE_REQUIRE_SCAN_JOB: "1",
      SMOKE_BACKEND_BASE_URL: origin,
      SMOKE_WORKER_METRICS_BASE_URL: origin,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`deployment smoke self-test exited with ${code ?? "unknown"}`));
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
  console.error(`FAIL deployment smoke self-test: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
