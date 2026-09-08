import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeRouteParam } from "../route-params";

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) {
      files.push(...collectSourceFiles(file));
      continue;
    }
    if (/\.tsx?$/.test(file)) files.push(file);
  }
  return files.map((file) => file.split(path.sep).join("/"));
}

describe("decodeRouteParam", () => {
  it("decodes well-formed escapes exactly like decodeURIComponent", () => {
    for (const raw of ["torvalds", "%74orvalds", "a%2Fb", "%E4%B8%AD%E6%96%87", "Rust"]) {
      expect(decodeRouteParam(raw)).toBe(decodeURIComponent(raw));
    }
  });

  it("returns the raw segment for a malformed escape instead of throwing", () => {
    // Next already decodes params, so `/api/badge/%25` reaches the route as "%".
    // decodeURIComponent throws URIError on those, which turned a bad handle
    // into a 500 on every param-decoding route.
    for (const raw of ["%", "%zz", "50%", "%E0%A4%A", "torvalds%"]) {
      expect(() => decodeURIComponent(raw)).toThrow();
      expect(decodeRouteParam(raw)).toBe(raw);
    }
  });

  it("treats missing segments as empty", () => {
    expect(decodeRouteParam(undefined)).toBe("");
    expect(decodeRouteParam(null)).toBe("");
    expect(decodeRouteParam("")).toBe("");
  });
});

describe("route param decoding discipline", () => {
  it("never calls decodeURIComponent directly on a route segment", () => {
    const offenders = collectSourceFiles("src/app").filter((file) =>
      readFileSync(file, "utf8").includes("decodeURIComponent("),
    );
    expect(
      offenders,
      `use decodeRouteParam from @/lib/route-params instead: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
