import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Islands only receive the message namespaces their Astro page passes through
// pickMessages(). A component that calls useTranslations("ns") for a namespace
// the page did not pass renders the raw key (e.g. "realms.mahayana.name").
// This walks each island's import graph and checks every literal namespace is
// passed by every page that mounts it.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const pagesDir = join(repo, "apps/web/src/pages");

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(repo, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

function namespacesUsed(file: string, seen = new Set<string>()): Set<string> {
  const found = new Set<string>();
  if (seen.has(file)) return found;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/useTranslations\(\s*"([\w.]+)"\s*\)/g)) found.add(m[1].split(".")[0]);
  for (const m of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms)) {
    const target = resolveImport(file, m[1]);
    if (target) for (const ns of namespacesUsed(target, seen)) found.add(ns);
  }
  return found;
}

function astroPages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return astroPages(path);
    return path.endsWith(".astro") ? [path] : [];
  });
}

function passedNamespaces(page: string, attrs: string): Set<string> | null {
  const list =
    attrs.match(/pickMessages\(messages,\s*\[([^\]]*)\]/)?.[1] ??
    attrs.match(/intl\(\[([^\]]*)\]\)/)?.[1] ??
    (/intl=\{intl\}/.test(attrs) ? page.match(/const intl = [^;]*pickMessages\(messages,\s*\[([^\]]*)\]/s)?.[1] : undefined);
  return list === undefined ? null : new Set([...list.matchAll(/"(\w+)"/g)].map((m) => m[1]));
}

const mounts = astroPages(pagesDir).flatMap((file) => {
  const page = readFileSync(file, "utf8");
  return [...page.matchAll(/<(\w+Island)\b([^>]*?)\/>/gs)].flatMap(([, island, attrs]) => {
    const passed = passedNamespaces(page, attrs);
    const spec = page.match(new RegExp(`import \\{[^}]*\\b${island}\\b[^}]*\\} from "([^"]+)"`))?.[1];
    const islandFile = spec ? resolveImport(file, spec) : null;
    return passed && islandFile ? [{ page: relative(repo, file), island, passed, islandFile }] : [];
  });
});

describe("Astro island messages", () => {
  it("finds the islands that render translated rating names", () => {
    const islands = new Set(mounts.map((m) => m.island));
    for (const island of ["LeaderboardIsland", "RoasterIsland", "ProfileIsland", "DeveloperFacetIsland"]) {
      expect(islands, island).toContain(island);
    }
  });

  it.each(mounts.map((m) => [`${m.page} <${m.island}>`, m] as const))("%s gets every namespace it uses", (_, mount) => {
    const missing = [...namespacesUsed(mount.islandFile)].filter((ns) => !mount.passed.has(ns)).sort();
    expect(missing).toEqual([]);
  });
});
