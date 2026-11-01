#!/usr/bin/env node
// Lists the next-intl message namespaces a component tree translates, by
// following its `@/` and relative imports through src/. Used when wiring a
// shared component as an Astro island, which receives only those namespaces
// (pickMessages) instead of the whole catalog.
//   node apps/web/scripts/island-namespaces.mjs src/components/talent/TalentDirectory.tsx
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const seen = new Set(), namespaces = new Set(), dynamic = [];
const resolveImport = (from, spec) => {
  const base = spec.startsWith("@/") ? resolve(root, "src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) if (existsSync(base + ext) && !base.endsWith("/") && (ext || /\.[jt]sx?$/.test(base))) return base + ext;
  return null;
};
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/(?:useTranslations|getTranslations)\(\s*(?:\{[^}]*namespace:\s*)?["'`]([\w.]+)["'`]/g)) namespaces.add(m[1].split(".")[0]);
  for (const m of src.matchAll(/(?:useTranslations|getTranslations)\(\s*([^"'`{)\s][^)]*)\)/g)) dynamic.push(`${file.replace(root + "/", "")}: ${m[1]}`);
  for (const m of src.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    const next = resolveImport(file, m[1] ?? m[2]);
    if (next && /\.(t|j)sx?$/.test(next)) walk(next);
  }
}
for (const entry of process.argv.slice(2)) walk(resolve(root, entry));
console.log(JSON.stringify([...namespaces].sort()));
if (dynamic.length) console.error("non-literal namespaces:\n  " + dynamic.join("\n  "));
