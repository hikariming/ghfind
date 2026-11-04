#!/usr/bin/env node
// Open-core split tooling. Nothing here contacts GitHub or pushes unless an
// explicit --push / --apply flag is given.
//
//   node ops/open-core/split.mjs check                 every tracked file is classified (CI gate)
//   node ops/open-core/split.mjs plan                  file counts per side and module
//   node ops/open-core/split.mjs list <public|private> files that end up in that repo
//   node ops/open-core/split.mjs blockers [--strict]   public files that still reference private code
//   node ops/open-core/split.mjs seed-private <git-url> [--push]
//        mirror main (full history) into the new private repo
//   node ops/open-core/split.mjs cutover <public|private> [--apply]
//        on a fresh branch, git rm everything that belongs only to the other side
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const manifest = JSON.parse(readFileSync(join(root, "ops/open-core/split-manifest.json"), "utf8"));
const git = (args, opts = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", ...opts });

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const rules = manifest.rules.map((r) => ({ ...r, re: globToRegExp(r.glob), hits: 0 }));
const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);

const classified = new Map();
const unmatched = [];
for (const f of files) {
  const rule = rules.find((r) => r.re.test(f));
  if (!rule) unmatched.push(f);
  else {
    rule.hits++;
    classified.set(f, rule);
  }
}
const sideOf = (f) => classified.get(f)?.side;
const inRepo = (f, side) => sideOf(f) === side || sideOf(f) === "both";

// Public files must not depend on private code once the repos are separate.
function findBlockers() {
  const out = [];
  const IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (const f of files) {
    if (sideOf(f) !== "public" || !/\.(ts|tsx|mts|mjs|js)$/.test(f)) continue;
    const text = readFileSync(join(root, f), "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1];
      let target = null;
      if (spec.startsWith(".")) target = join(f, "..", spec);
      else if (spec.startsWith("@/")) target = "src/" + spec.slice(2);
      if (!target) continue;
      const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}.mjs`];
      const hit = candidates.find((c) => classified.has(c));
      if (hit && sideOf(hit) === "private") out.push(`${f} -> ${hit}`);
    }
  }
  return [...new Set(out)];
}

const [cmd, arg, ...flags] = process.argv.slice(2);
const has = (flag) => flags.includes(flag) || arg === flag;

switch (cmd) {
  case "check": {
    if (unmatched.length) {
      console.error(`unclassified files (${unmatched.length}); add a rule to ops/open-core/split-manifest.json:`);
      for (const f of unmatched.slice(0, 50)) console.error(`  ${f}`);
      process.exit(1);
    }
    const stale = rules.filter((r) => r.hits === 0).map((r) => r.glob);
    if (stale.length) console.warn(`warning: rules matching no files: ${stale.join(", ")}`);
    const blockers = findBlockers();
    console.log(`split manifest: ok — ${files.length} files classified; ${blockers.length} public->private reference(s) left before cutover (run: blockers)`);
    break;
  }
  case "plan": {
    const count = {};
    for (const [, r] of classified) {
      const k = `${r.side.padEnd(8)} ${r.module}`;
      count[k] = (count[k] ?? 0) + 1;
    }
    for (const [k, n] of Object.entries(count).sort()) console.log(`${String(n).padStart(5)}  ${k}`);
    break;
  }
  case "list": {
    if (!["public", "private"].includes(arg)) throw new Error("usage: list <public|private>");
    for (const f of files) if (inRepo(f, arg)) console.log(f);
    break;
  }
  case "blockers": {
    const blockers = findBlockers();
    for (const b of blockers) console.log(b);
    console.error(`${blockers.length} public->private reference(s)`);
    if (has("--strict") && blockers.length) process.exit(1);
    break;
  }
  case "seed-private": {
    if (!arg || arg.startsWith("--")) throw new Error("usage: seed-private <git-url> [--push]");
    const dir = mkdtempSync(join(tmpdir(), "ghfind-private-seed-"));
    const steps = [
      ["clone", "--no-local", "--single-branch", "--branch", "main", root, dir],
      ["-C", dir, "remote", "set-url", "origin", arg],
      ["-C", dir, "push", "origin", "main:main"],
    ];
    console.log("The private repo starts as a full-history mirror of main; the private");
    console.log("cutover PR (cutover private --apply) then removes public-only paths.\n");
    for (const s of steps) console.log(`git ${s.join(" ")}`);
    if (!has("--push")) {
      console.log("\n(dry run — pass --push to execute; the target repo must already exist and be private)");
      break;
    }
    for (const s of steps) execFileSync("git", s, { stdio: "inherit" });
    console.log(`\nseeded ${arg} from ${dir}`);
    break;
  }
  case "cutover": {
    if (!["public", "private"].includes(arg)) throw new Error("usage: cutover <public|private> [--apply]");
    const other = arg === "public" ? "private" : "public";
    const remove = files.filter((f) => sideOf(f) === other);
    console.log(`${arg} cutover removes ${remove.length} ${other}-only files and keeps ${files.length - remove.length}.`);
    if (arg === "public") {
      const blockers = findBlockers();
      if (blockers.length) {
        console.error(`refusing: ${blockers.length} public file(s) still import private code:\n  ${blockers.join("\n  ")}`);
        process.exit(1);
      }
    }
    if (!has("--apply")) {
      console.log("(dry run — pass --apply on a fresh branch to git rm them)");
      break;
    }
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (branch === "main" || git(["status", "--porcelain"]).trim()) {
      console.error("refusing: run on a clean, non-main branch");
      process.exit(1);
    }
    for (let i = 0; i < remove.length; i += 200) git(["rm", "-q", "--", ...remove.slice(i, i + 200)]);
    console.log(`removed ${remove.length} files; follow docs/architecture/open-core-split.md "Cutover" for the ${arg} checklist.`);
    break;
  }
  default:
    console.error("usage: split.mjs <check|plan|list|blockers|seed-private|cutover> ...");
    process.exit(2);
}
