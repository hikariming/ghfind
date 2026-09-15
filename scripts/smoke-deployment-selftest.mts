import assert from "node:assert/strict";
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

type FeedMode = "valid" | "anonymous_allowed" | "forged_allowed" | "cached_rejection" | "wrong_error" | "redirected_rejection";
function startFixtureServer(mode: FeedMode = "valid"): Promise<{ origin: string; feedRequests: boolean[]; close: () => Promise<void> }> {
  const feedRequests: boolean[] = [];
  const server = http.createServer((request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    const origin = `http://${host}`;
    if (request.method === "GET" && url.pathname === "/api/feed/projects") {
      assert.equal(url.search, "?limit=1");
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers.authorization, undefined);
      const forged = request.headers["x-feed-gateway"] !== undefined;
      feedRequests.push(forged);
      if (forged) {
        assert.equal(request.headers["x-feed-gateway"], "forged.invalid.signature");
        assert.equal(request.headers["x-github-id"], "109743670");
        assert.equal(request.headers["x-github-login"], "asperformias");
      }
      if (mode === "redirected_rejection") {
        response.writeHead(302, { location: "/fixture-login" }); response.end(); return;
      }
      const status = (mode === "anonymous_allowed" && !forged) || (mode === "forged_allowed" && forged) ? 200 : 401;
      writeJSON(response, status, { error: mode === "wrong_error" ? "unrelated_failure" : "authentication_required" },
        { "cache-control": mode === "cached_rejection" ? "public, max-age=60" : "no-store" });
      return;
    }
    if (url.pathname === "/fixture-login") {
      writeJSON(response, 401, { error: "authentication_required" }, { "cache-control": "no-store" }); return;
    }
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
    if (request.method === "GET" && url.pathname === "/projects") {
      writeText(response, 200, "<html><main>projects</main></html>", {
        "content-type": "text/html; charset=utf-8",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/sitemap.xml") {
      writeText(response, 200, "<?xml version=\"1.0\"?><urlset></urlset>", {
        "content-type": "application/xml; charset=utf-8",
      });
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
        feedRequests,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

async function runSmoke(origin: string, failure?: RegExp): Promise<void> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["smoke:deployment"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SMOKE_ALLOW_HTTP: "1",
      SMOKE_BASE_URL: origin,
      SMOKE_EXPECTED_ORIGIN: origin,
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

  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      try {
        if (failure) { assert.notEqual(code, 0); assert.match(output, failure); }
        else { assert.equal(code, 0, output); assert.match(output, /PASS deployment smoke/); }
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

async function main(): Promise<void> {
  const cases: [FeedMode, RegExp?][] = [
    ["valid"], ["anonymous_allowed", /anonymous Feed rejection returned 200/],
    ["forged_allowed", /forged Feed identity rejection returned 200/],
    ["cached_rejection", /Feed authentication rejection contract differs/],
    ["wrong_error", /Feed authentication rejection contract differs/],
    ["redirected_rejection", /anonymous Feed rejection returned 302/],
  ];
  for (const [mode, failure] of cases) {
    const fixture = await startFixtureServer(mode);
    try {
      await runSmoke(fixture.origin, failure);
      assert.deepEqual(fixture.feedRequests, ["valid", "forged_allowed"].includes(mode) ? [false, true] : [false]);
      console.log(`PASS deployment smoke self-test ${mode}`);
    } finally { await fixture.close(); }
  }
}

main().catch((error: unknown) => {
  console.error(`FAIL deployment smoke self-test: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
