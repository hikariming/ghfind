#!/usr/bin/env node
// Real Next/OpenNext compilation with a minimal public environment. No deploy.
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoLocalEnvironmentFiles, safeBuildEnvironment, renderWeb, repository } from "./feed-platform-web.mjs";

export function artifactInventory(path) {
  const entries = []; let bytes = 0;
  function visit(directory) {
    for (const name of readdirSync(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const file = resolve(directory, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("build artifact symlink rejected");
      if (stat.isDirectory()) { visit(file); continue; }
      if (!stat.isFile() || entries.length >= 20000 || (bytes += stat.size) > 1024 * 1024 * 1024) throw new Error("build artifact inventory exceeds limits");
      const hash = createHash("sha256"), fd = openSync(file, "r"), buffer = Buffer.alloc(1024 * 1024);
      try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
      finally { closeSync(fd); }
      entries.push({ path: relative(path, file), bytes: stat.size, sha256: hash.digest("hex") });
    }
  }
  visit(path);
  if (!entries.some(e => e.path === "worker.js") || !entries.some(e => e.path.startsWith("assets/"))) throw new Error("OpenNext worker/assets missing");
  return { files: entries, bytes, sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}
export function compileWeb({ manifest, sha, output, root = repository, runner = spawnSync, git = execFileSync }) {
  const config = renderWeb(manifest, sha);
  const configuredPath = resolve(root, "platform/runtime/wrangler.web.staging.generated.json");
  if (JSON.stringify(JSON.parse(readFileSync(configuredPath, "utf8"))) !== JSON.stringify(config)) throw new Error("generated Web config differs from manifest");
  if (git("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !== sha ||
      git("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("clean exact source checkout required for staging build");
  assertNoLocalEnvironmentFiles(root);
  if (existsSync(resolve(root, ".next")) || existsSync(resolve(root, ".open-next"))) throw new Error("fresh Next/OpenNext output directories required");
  const out = resolve(output);
  if (out.startsWith(root + "/") || existsSync(out)) throw new Error("fresh build receipt outside checkout required");
  const sourceTree = git("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const startedAt = new Date().toISOString();
  const run = runner(process.execPath, [resolve(root, "node_modules/@opennextjs/cloudflare/dist/cli/index.js"), "build", "--config", configuredPath], {
    cwd: root, env: safeBuildEnvironment(manifest, sha), timeout: 600000, stdio: "inherit",
  });
  if (run.error || run.status !== 0) throw new Error("Next/OpenNext staging build failed");
  assertNoLocalEnvironmentFiles(root);
  const inventory = artifactInventory(resolve(root, ".open-next"));
  const result = { format: "ghfind-feed-web-build-v1", status: "passed", sourceSha: sha, sourceTree,
    startedAt, finishedAt: new Date().toISOString(), origin: manifest.web.origin,
    compiler: { next: JSON.parse(readFileSync(resolve(root, "node_modules/next/package.json"))).version,
      openNext: JSON.parse(readFileSync(resolve(root, "node_modules/@opennextjs/cloudflare/package.json"))).version },
    publicBuildEnvironment: safeBuildEnvironment(manifest, sha, {}), runtimeSecretsPresentDuringBuild: false,
    inventory, configSHA256: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    note: "Build receipt only; deployment and real OAuth journey are separate gates." };
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [manifest, sha, output, ...extra] = process.argv.slice(2);
    if (!manifest || !sha || !output || extra.length) throw new Error("usage: feed-platform-web-build.mjs MANIFEST SHA FRESH_RECEIPT");
    compileWeb({ manifest: JSON.parse(readFileSync(manifest, "utf8")), sha, output });
    console.log("Actual Next/OpenNext build completed without runtime credentials");
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
