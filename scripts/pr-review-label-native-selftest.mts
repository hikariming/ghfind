// Run with Node 22: node --experimental-strip-types scripts/pr-review-label-native-selftest.mts
// Real timers and native fetch: only the scoring URL in a temporary script copy changes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const source = await readFile(new URL("./pr-review-label.mts", import.meta.url), "utf8");

await test("score deadline with native fetch", { concurrency: true }, async (t) => {
  await Promise.all((["complete", "late", "unfinished"] as const).map((mode) => t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-review-label-native-"));
    let requests = 0;
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"final_score":');
      if (mode !== "unfinished" || requests > 1) {
        bodyTimer = setTimeout(() => response.end("70}"), mode === "late" && requests === 1 ? 65_000 : 20);
      }
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address === "object");
      const script = join(directory, "pr-review-label.mts");
      assert(source.includes("https://ghfind.com/api/score/"));
      await writeFile(script, source.replace("https://ghfind.com/api/score/", `http://127.0.0.1:${address.port}/api/score/`));
      const { fetchScore, scoreToLabel } = await import(pathToFileURL(script).href);
      const started = performance.now();
      const score = await Promise.race([
        fetchScore("octocat"),
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => reject(new Error(`${mode}: no result within 72 seconds`)), 72_000);
        }),
      ]);
      const elapsedMs = Math.round(performance.now() - started);
      console.log(JSON.stringify({ mode, node: process.version, requests, score, elapsedMs }));
      assert.equal(requests, mode === "complete" ? 1 : 2);
      assert.equal(score, 70);
      if (mode !== "complete") {
        assert.equal(scoreToLabel(score), "review-level: high");
        assert(elapsedMs >= 65_000 && elapsedMs < 69_000, `deadline missed: ${elapsedMs}ms`);
      }
    } finally {
      clearTimeout(bodyTimer);
      clearTimeout(watchdog);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  })));
});
