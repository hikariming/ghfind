// Real Node 22 CLI, native fetch, and wall-clock deadlines; only endpoint URLs change.
// Assert child exit before server cleanup so cleanup cannot hide leaked connections.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REVIEW_LABELS = ["low", "medium", "high", "xhigh", "unavailable"].map((level) => `review-level: ${level}`);

const source = await readFile(new URL("./pr-review-label.mts", import.meta.url), "utf8");

await test("CLI exits after native HTTP recovery", { concurrency: true }, async (t) => {
  await Promise.all((["complete", "late", "unfinished", "unavailable", "forbidden-body"] as const).map((mode) => t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-label-native-"));
    const labels = new Set(["bug", "review-level: low"]);
    const expected = `review-level: ${mode === "unavailable" ? "unavailable" : mode === "late" ? "medium" : "high"}`;
    let scores = 0;
    let preflights = 0;
    let stalledConnectionClosed = false;
    let serverError: unknown;
    let child: ChildProcess | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const bodyTimers = new Set<ReturnType<typeof setTimeout>>();
    let stdout = "";
    let stderr = "";
    const stall = (response: ServerResponse, status: number) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.write("{");
      response.on("close", () => { stalledConnectionClosed = !response.writableEnded; });
      if (mode === "late") {
        const timer = setTimeout(() => response.end('"final_score":90}'), 65_000);
        bodyTimers.add(timer);
        response.on("close", () => { clearTimeout(timer); bodyTimers.delete(timer); });
      }
    };
    const server = createServer(async (request, response) => {
      const json = (status: number, data: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(data));
      };
      try {
        const path = decodeURIComponent(new URL(request.url!, "http://localhost").pathname);
        if (path === "/api/score/octocat") {
          assert.equal(request.headers.authorization, undefined);
          scores++;
          if (scores === 1 && ["late", "unfinished", "unavailable"].includes(mode)) return stall(response, 200);
          return mode === "unavailable" ? json(404, {}) : json(200, { final_score: mode === "late" ? 45 : 70 });
        }
        assert.equal(request.headers.authorization, "Bearer native-test-only");
        const base = "/repos/fixture/repo";
        if (path === `${base}/labels`) {
          preflights++;
          if (mode === "forbidden-body" && preflights === 1) return stall(response, 403);
          return json(200, REVIEW_LABELS.map((name) => ({ name })));
        }
        if (path.startsWith(`${base}/labels/`)) return json(200, { name: path.slice(`${base}/labels/`.length) });
        if (path === `${base}/issues/42/labels`) {
          if (request.method === "POST") {
            let body = "";
            for await (const chunk of request) body += chunk;
            for (const label of JSON.parse(body).labels) labels.add(label);
          } else assert.equal(request.method, "GET");
          return json(200, [...labels].map((name) => ({ name })));
        }
        if (path.startsWith(`${base}/issues/42/labels/`) && request.method === "DELETE") {
          assert(labels.has(expected));
          labels.delete(path.slice(`${base}/issues/42/labels/`.length));
          return json(200, [...labels].map((name) => ({ name })));
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      } catch (error) {
        serverError = error;
        json(500, { error: "fixture failure" });
      }
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      const script = join(directory, "pr-review-label.mts");
      const eventPath = join(directory, "event.json");
      assert(source.includes("https://ghfind.com/api/score/") && source.includes("https://api.github.com/repos/"));
      await writeFile(script, source
        .replace("https://ghfind.com/api/score/", `${origin}/api/score/`)
        .replaceAll("https://api.github.com/repos/", `${origin}/repos/`));
      await writeFile(eventPath, JSON.stringify({
        action: "opened", number: 42, sender: { login: "someone-else" },
        pull_request: { draft: true, user: { login: "octocat" }, head: { repo: { fork: true } } },
      }));
      const started = performance.now();
      child = spawn(process.execPath, ["--experimental-strip-types", "pr-review-label.mts"], {
        cwd: directory,
        env: { ...process.env, GITHUB_TOKEN: "native-test-only", GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: eventPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.on("data", (chunk) => { stdout += chunk; });
      child.stderr!.on("data", (chunk) => { stderr += chunk; });
      const [code, signal] = await Promise.race([
        once(child, "close"),
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => {
            child!.kill("SIGKILL");
            reject(new Error(`${mode}: CLI did not exit within 75 seconds; stdout=${stdout}; stderr=${stderr}`));
          }, 75_000);
        }),
      ]);
      assert.equal(serverError, undefined);
      assert.equal(code, 0, stderr);
      assert.equal(signal, null);
      assert(stdout.includes(expected), stdout);
      assert.deepEqual(labels, new Set(["bug", expected]));
      assert.equal(scores, ["late", "unfinished", "unavailable"].includes(mode) ? 2 : 1);
      const elapsedMs = Math.round(performance.now() - started);
      if (mode !== "complete") {
        assert(stalledConnectionClosed, "CLI must cancel the stalled response before exiting");
        assert(elapsedMs >= 65_000 && elapsedMs < 72_000, `deadline missed: ${elapsedMs}ms`);
      }
      console.log(JSON.stringify({ mode, node: process.version, scores, label: expected, elapsedMs, exitCode: code, stalledConnectionClosed }));
    } finally {
      clearTimeout(watchdog);
      for (const timer of bodyTimers) clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "close");
        child.kill("SIGKILL");
        await exited;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  })));
});
