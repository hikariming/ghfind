import { describe, expect, it } from "vitest";
import corpus from "./classify-corpus.json";
import { MERGE_TITLE, TITLE_KIND, classifyPr, fileKind, pyRe } from "../classify";
import { CLASSIFY_CASES, runClassifyCase } from "./classify-cases";

// classify-corpus.json: collect.py's outputs on a sample of real inputs
// (scripts/devscore-classify-corpus.py --per-fn); the full corpus runs via
// scripts/devscore-classify-parity.mts.
describe("classify parity with collect.py", () => {
  const cases = (corpus as { cases: [string, unknown[], unknown][] }).cases;

  it("covers every ported function", () => {
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(Object.keys(CLASSIFY_CASES)));
  });

  it("returns collect.py's output on every corpus case", () => {
    const bad = cases.flatMap(([fn, args, want]) => {
      const d = runClassifyCase(fn, args, want);
      return d ? [`${fn}(${JSON.stringify(args).slice(0, 200)}): ${d}`] : [];
    });
    expect(bad).toEqual([]);
  });
});

describe("pyRe keeps Python re semantics", () => {
  it("$ also matches before a final newline", () => {
    expect(MERGE_TITLE.test("merge main into dev\n")).toBe(true);
    expect(fileKind("README.md\n")).toBe("docs");
    expect(fileKind("README.md\n\n")).toBe("core");
  });

  it("\\b and \\w are Unicode-aware", () => {
    // a CJK letter before "bump" is a word character: no boundary, so no chore title
    expect(classifyPr("修复bump", null, "code")).toBe("core");
    expect(classifyPr("修复 bump", null, "code")).toBe("chore");
    expect(TITLE_KIND[0][1].test("ändern(docs): x")).toBe(true);
  });

  it("re.I matches dotted/dotless i like Python", () => {
    expect(pyRe("wiki", true).test("w\u0130k\u0131")).toBe(true);
    expect(pyRe("[a-z]+$", true).test("\u0131")).toBe(true);
  });
});
