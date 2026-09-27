/**
 * Parity check of the TypeScript devscore engine (src/lib/devscore/engine)
 * against devscore's Zig CLI (`zig-out/bin/devscore --json`), on every data
 * file of a devscore checkout: data/*.json and <set>/data/*.json.
 *
 *   pnpm tsx scripts/devscore-parity.mts [devscore dir]   (default: $DEVSCORE_DIR or ../devscore)
 *
 * Build the CLI first: `cd <devscore dir> && zig build`. Compares the full
 * `Rated` result field by field: numbers within 1e-9 (reported as the max
 * abs diff per field path), everything else (tier, flags, confidence, status,
 * exclusions, repo order) identical. Exits 1 on any mismatch.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseDeveloper } from "../src/lib/devscore/model";
import { rateDeveloper } from "../src/lib/devscore/engine";

const TOLERANCE = 1e-9;
const root = resolve(process.argv[2] ?? process.env.DEVSCORE_DIR ?? join(import.meta.dirname, "../../devscore"));
const cli = join(root, "zig-out/bin/devscore");
if (!existsSync(cli)) {
  console.error(`missing ${cli}: run \`zig build\` in ${root}`);
  process.exit(2);
}

const dataDirs = [join(root, "data")];
for (const name of readdirSync(root).sort()) {
  const d = join(root, name, "data");
  if (statSync(join(root, name)).isDirectory() && existsSync(d)) dataDirs.push(d);
}
const files = dataDirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(d, f)),
);

const lines = execFileSync(cli, ["--json", ...files], { cwd: root, maxBuffer: 1 << 30, encoding: "utf8" }).trim().split("\n");
if (lines.length !== files.length) throw new Error(`CLI printed ${lines.length} lines for ${files.length} files`);

const maxDiff = new Map<string, number>();
const mismatches: string[] = [];

/** Walks both results in step; array indices collapse to `[]` in the per-field report. */
function compare(zig: unknown, ts: unknown, path: string, field: string, file: string): void {
  if (typeof zig === "number" && typeof ts === "number") {
    const d = Math.abs(zig - ts);
    maxDiff.set(field, Math.max(maxDiff.get(field) ?? 0, d));
    if (!(d <= TOLERANCE)) mismatches.push(`${file} ${path}: zig ${zig} ts ${ts} (diff ${d})`);
    return;
  }
  if (Array.isArray(zig) && Array.isArray(ts)) {
    if (zig.length !== ts.length) mismatches.push(`${file} ${path}: length zig ${zig.length} ts ${ts.length}`);
    for (let i = 0; i < Math.min(zig.length, ts.length); i++) compare(zig[i], ts[i], `${path}[${i}]`, `${field}[]`, file);
    return;
  }
  if (zig !== null && ts !== null && typeof zig === "object" && typeof ts === "object") {
    const z = zig as Record<string, unknown>;
    const t = ts as Record<string, unknown>;
    for (const k of new Set([...Object.keys(z), ...Object.keys(t)])) {
      if (!(k in z) || !(k in t)) mismatches.push(`${file} ${path}.${k}: only in ${k in z ? "zig" : "ts"}`);
      else compare(z[k], t[k], `${path}.${k}`, `${field}.${k}`, file);
    }
    return;
  }
  if (zig !== ts) mismatches.push(`${file} ${path}: zig ${JSON.stringify(zig)} ts ${JSON.stringify(ts)}`);
}

let passed = 0;
files.forEach((file, i) => {
  const rel = relative(root, file);
  const before = mismatches.length;
  const ts = rateDeveloper(parseDeveloper(JSON.parse(readFileSync(file, "utf8"))));
  compare(JSON.parse(lines[i]), JSON.parse(JSON.stringify(ts)), "", "", rel);
  if (mismatches.length === before) passed += 1;
});

console.log("max abs diff per field:");
for (const [field, d] of [...maxDiff].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${d.toExponential(2).padStart(9)}  ${field}`);
}
for (const m of mismatches.slice(0, 50)) console.log(`MISMATCH ${m}`);
if (mismatches.length > 50) console.log(`... ${mismatches.length - 50} more mismatches`);
console.log(`${passed}/${files.length} files identical (numbers within ${TOLERANCE})`);
process.exit(passed === files.length ? 0 : 1);
