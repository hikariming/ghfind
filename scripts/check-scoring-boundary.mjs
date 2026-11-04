#!/usr/bin/env node
// Open-core boundary gate for the public scoring module (scoring/).
//
// The scoring module is the part of ghfind that stays public after the split
// (docs/architecture/open-core-split.md). It must stay a pure, deterministic
// function of already-collected evidence, so it can never carry the private
// backend's GitHub token pool, network access, storage, or traffic control.
//
// Checks:
//   1. TypeScript sources import only sibling modules (no app, node:, or npm deps)
//      and use no I/O, environment, timer, or randomness globals.
//   2. Go sources import only an allow-listed subset of the standard library.
//   3. Nothing under scoring/ contains a GitHub credential.
//   4. Consumers reach scoring only through the package / module name, never by
//      relative path into scoring/src, so swapping the workspace link for a
//      registry version is a one-line change in the private repo.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const scoringDir = join(root, "scoring");
const errors = [];

function walk(dir, filter, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}
const rel = (p) => relative(root, p);

// 1. TypeScript purity
const FORBIDDEN_TS = [
  [/\bfetch\s*\(/, "network access (fetch)"],
  [/\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/, "network access"],
  [/\bprocess\s*\./, "environment/process access"],
  [/\bglobalThis\b/, "global state"],
  [/\brequire\s*\(/, "dynamic require"],
  [/\bimport\s*\(/, "dynamic import"],
  [/\bAsyncLocalStorage\b/, "request-scoped state"],
  [/\bDate\.now\s*\(/, "wall clock (inject `now` instead)"],
  [/\bMath\.random\s*\(/, "randomness"],
  [/\bset(Timeout|Interval|Immediate)\s*\(/, "timers"],
  [/\b(localStorage|sessionStorage|indexedDB|caches)\b/, "storage"],
  [/\bcrypto\s*\./, "crypto/randomness"],
];
for (const file of walk(join(scoringDir, "src"), (p) => p.endsWith(".ts"))) {
  const text = readFileSync(file, "utf8");
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"'`;]*?from\s*["']([^"']+)["']/g)) {
    if (!m[1].startsWith("./") && !m[1].startsWith("../rules/"))
      errors.push(`${rel(file)}: imports "${m[1]}" — scoring/src may only import sibling modules and ../rules/*.json`);
  }
  for (const [re, what] of FORBIDDEN_TS) {
    if (re.test(code)) errors.push(`${rel(file)}: ${what} is not allowed in the public scoring module`);
  }
}

// 2. Go standard-library allow-list (non-test files of every package)
const GO_ALLOWED = new Set(["embed", "errors", "fmt", "math", "regexp", "sort", "strconv", "strings", "unicode", "unicode/utf8"]);
try {
  const out = execFileSync("go", ["list", "-f", "{{.ImportPath}}|{{join .Imports \",\"}}", "./..."], {
    cwd: scoringDir,
    encoding: "utf8",
  });
  for (const line of out.trim().split("\n")) {
    const [pkg, imports] = line.split("|");
    for (const imp of imports ? imports.split(",") : []) {
      if (!GO_ALLOWED.has(imp)) errors.push(`${pkg}: imports "${imp}" — not in the scoring Go allow-list`);
    }
  }
} catch (err) {
  errors.push(`go list failed in scoring/: ${err.message.split("\n")[0]}`);
}

// 3. Credentials
const TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/;
for (const file of walk(scoringDir, (p) => /\.(ts|mts|go|json|md)$/.test(p))) {
  if (TOKEN.test(readFileSync(file, "utf8"))) errors.push(`${rel(file)}: contains a GitHub credential`);
}

// 4. Consumers use the package name, not paths into the module
const consumerRoots = ["src", "apps", "scripts", "platform", "packages", "internal", "cmd"].map((d) => join(root, d));
const DEEP = /["'`](?:\.\.\/)+scoring\/(?:src|tools)\//;
for (const dir of consumerRoots) {
  let files = [];
  try {
    files = walk(dir, (p) => /\.(ts|tsx|mts|mjs|astro|go)$/.test(p));
  } catch {
    continue;
  }
  for (const file of files) {
    if (DEEP.test(readFileSync(file, "utf8")))
      errors.push(`${rel(file)}: import @ghfind/scoring/<module> instead of a relative path into scoring/`);
  }
}

if (errors.length) {
  console.error(`scoring boundary: ${errors.length} violation(s)\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log("scoring boundary: ok (pure TS, stdlib-only Go, no credentials, package-name imports only)");
