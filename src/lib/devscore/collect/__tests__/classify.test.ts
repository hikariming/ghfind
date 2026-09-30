import { describe, expect, it } from "vitest";
import {
  MERGE_TITLE,
  TITLE_KIND,
  classifyCommit,
  classifyPr,
  fileKind,
  githubOwner,
  isContentTree,
  kindWithEvidence,
  maintMonths,
  monthKey,
  mutualMergerPairs,
  normRepoUrl,
  packageNames,
  prBatchShare,
  prMergers,
  prSubstance,
  pyRe,
  repoKind,
} from "../classify";

describe("fileKind", () => {
  it.each([
    ["src/app.ts", "core"],
    ["README.md", "docs"],
    ["locales/en.json", "docs"],
    ["public/logo.svg", "docs"],
    ["src/__tests__/app.test.ts", "test"],
    ["pkg/server_test.go", "test"],
    ["data/points.csv", "data"],
    ["data/stations.txt", "data"],
    ["data/README.txt", "docs"],
    [".github/workflows/ci.yml", "chore"],
    ["yarn.lock", "chore"],
    ["package.json", "chore"],
  ])("%s -> %s", (path, kind) => {
    expect(fileKind(path)).toBe(kind);
  });
});

describe("classifyPr", () => {
  it("branch-sync titles are merges whatever the files", () => {
    expect(classifyPr("Merge branch 'main' into feature", ["src/a.ts"], "code")).toBe("merge");
    expect(classifyPr("chore: sync main into dev", null, "code")).toBe("merge");
  });

  it("site repos and mostly-site diffs are site", () => {
    expect(classifyPr("fix nav", ["src/a.ts"], "site")).toBe("site");
    expect(classifyPr("fix nav", ["website/a.html", "website/b.html", "src/a.ts"], "code")).toBe("site");
  });

  it("any core file makes the PR core", () => {
    expect(classifyPr("docs: tweak", ["README.md", "src/a.ts"], "code")).toBe("core");
  });

  it("without core files the majority kind wins, ties favour test", () => {
    expect(classifyPr("x", ["README.md", "docs/a.md", "yarn.lock"], "code")).toBe("docs");
    expect(classifyPr("x", ["src/a.test.ts", "yarn.lock"], "code")).toBe("test");
  });

  it("falls back to the title without a file list", () => {
    expect(classifyPr("docs: fix typo", null, "code")).toBe("docs");
    expect(classifyPr("add tests for parser", [], "code")).toBe("test");
    expect(classifyPr("chore(deps): bump lodash", null, "code")).toBe("chore");
    expect(classifyPr("add retry to client", null, "code")).toBe("core");
    expect(classifyPr("add retry to client", null, "data")).toBe("data");
  });
});

describe("classifyCommit", () => {
  const src = [{ filename: "src/p.ts", additions: 3, deletions: 1 }];

  it("multi-parent and branch-sync commits are merges", () => {
    expect(classifyCommit("fix parser", 2, src)).toBe("merge");
    expect(classifyCommit("Merge pull request #1 from a/b\n\nbody", 1, src)).toBe("merge");
  });

  it("empty or rename-only diffs are chores", () => {
    expect(classifyCommit("move", 1, [])).toBe("chore");
    expect(classifyCommit("move", 1, [{ filename: "src/p.ts", additions: 0, deletions: 0 }])).toBe("chore");
  });

  it("uses the first message line and the PR file rules", () => {
    expect(classifyCommit("fix parser\n\nMerge main into dev", 1, src)).toBe("core");
    expect(classifyCommit("update", 1, [{ filename: "README.md", additions: 2 }])).toBe("docs");
  });
});

describe("repoKind", () => {
  it.each([
    ["alice/Alice", null, "profile"],
    ["alice/awesome-rust", null, "list"],
    ["alice/alice.github.io", null, "site"],
    ["alice/foo", "Official website of Foo", "site"],
    ["alice/dotfiles", null, "config"],
    ["alice/project-docs", null, "docs"],
    ["alice/kubecon-talk", null, "content"],
    ["alice/tool", "A CLI", "code"],
  ])("%s (%s) -> %s", (repo, desc, kind) => {
    expect(repoKind(repo, "alice", desc)).toBe(kind);
  });

  it("a markdown-only root is content, a code dir makes it code", () => {
    const md = { name: "README.md", extension: ".md" };
    expect(repoKind("alice/notes", "alice", null, [md, { name: "ideas", type: "tree" }])).toBe("content");
    expect(repoKind("alice/notes", "alice", null, [md, { name: "src", type: "tree" }])).toBe("code");
  });
});

describe("isContentTree", () => {
  it("needs markdown and no code file or build manifest", () => {
    expect(isContentTree(null)).toBe(false);
    expect(isContentTree([{ name: "LICENSE" }])).toBe(false);
    expect(isContentTree([{ name: "notes.MD", extension: ".MD" }])).toBe(true);
    expect(isContentTree([{ name: "README.md", extension: ".md" }, { name: "Makefile" }])).toBe(false);
  });
});

describe("kindWithEvidence", () => {
  const c = (kind: string, substance = 10) => ({ kind, substance });

  it("keeps the guess on small samples and non code/content kinds", () => {
    expect(kindWithEvidence("content", "a/notes", [c("core"), c("core"), c("core")])).toBe("content");
    expect(kindWithEvidence("site", "a/x", [c("data"), c("data"), c("data"), c("data")])).toBe("site");
  });

  it("content with mostly substantive core commits is code, unless it is a talk", () => {
    const sample = [c("core"), c("core"), c("core"), c("docs")];
    expect(kindWithEvidence("content", "a/notes", sample)).toBe("code");
    expect(kindWithEvidence("content", "a/slides", sample)).toBe("content");
  });

  it("mostly data commits among ≥ 4 non-merge commits make it data", () => {
    expect(kindWithEvidence("code", "a/x", [c("data"), c("data"), c("data"), c("core")])).toBe("data");
    expect(kindWithEvidence("code", "a/x", [c("data"), c("data"), c("merge"), c("merge"), c("core")])).toBe("code");
  });
});

describe("prMergers", () => {
  it("counts mergers, keys self and bots, orders by count then key", () => {
    const got = prMergers(
      {
        1: { mergedBy: { login: "Alice" } },
        2: { mergedBy: { login: "bob" } },
        3: { mergedBy: { login: "bob" } },
        4: { mergedBy: { login: "dependabot[bot]" } },
        5: { mergedBy: { login: "ci", __typename: "Bot" } },
        6: { mergedBy: null },
      },
      "alice",
    );
    expect(Object.entries(got!)).toEqual([["[bot]", 2], ["bob", 2], ["[self]", 1]]);
  });

  it("is null when no merger is known", () => {
    expect(prMergers({}, "alice")).toBeNull();
    expect(prMergers({ 1: { mergedBy: null } }, "alice")).toBeNull();
  });
});

describe("mutualMergerPairs", () => {
  it("takes independent mergers once, busiest repo first", () => {
    const mergers = { "o/a": { "[self]": 3, bob: 1 }, "o/b": { Bob: 2, carol: 1, "[bot]": 1 } };
    expect(mutualMergerPairs(mergers, { "o/a": 1, "o/b": 5 })).toEqual([["o/b", "Bob"], ["o/b", "carol"]]);
  });

  it("stops at 10 distinct mergers", () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${i}`, 1]));
    expect(mutualMergerPairs({ "o/a": many }, {})).toHaveLength(10);
  });
});

describe("prSubstance", () => {
  it("counts only hand-written product code", () => {
    const files = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "README.md", additions: 100 },
      { path: "src/a.test.ts", additions: 50 },
      { path: "package-lock.json", additions: 1000 },
      { path: "vendor/x.go", additions: 30 },
      { path: "maps/route.wpt", additions: 40 },
    ];
    expect(prSubstance(files)).toBe(15);
  });

  it("is capped", () => {
    expect(prSubstance([{ path: "src/big.ts", additions: 5000 }])).toBe(2000);
  });
});

describe("prBatchShare", () => {
  const pr = (number: number, day: string) => ({ number, mergedAt: `${day}T12:00:00Z` });

  it("is null below 5 distinct merged PRs", () => {
    const nodes = [pr(1, "2024-01-01"), pr(1, "2024-01-01"), pr(2, "2024-01-02"), pr(3, "2024-01-03"), pr(4, "2024-01-04"), null, { number: 5 }];
    expect(prBatchShare(nodes)).toBeNull();
  });

  it("is the share merged on days with ≥ 3 merges", () => {
    const nodes = [pr(1, "2024-01-01"), pr(2, "2024-01-01"), pr(3, "2024-01-01"), pr(4, "2024-01-02"), pr(5, "2024-01-03")];
    expect(prBatchShare(nodes)).toBe(0.6);
  });
});

describe("months", () => {
  it("monthKey is the YYYY-MM prefix", () => {
    expect(monthKey("2024-03-15T10:00:00Z")).toBe("2024-03");
  });

  it("maintMonths counts months with ≥ 3 events", () => {
    expect(maintMonths({ "2024-01": 3, "2024-02": 2, "2024-03": 10 })).toBe(2);
  });
});

describe("package helpers", () => {
  it("normRepoUrl strips whitespace, case, trailing slashes and .git", () => {
    expect(normRepoUrl(" https://GitHub.com/Foo/Bar.git/ ")).toBe("https://github.com/foo/bar");
    expect(normRepoUrl(null)).toBe("");
  });

  it("githubOwner reads the owner of GitHub URLs only", () => {
    expect(githubOwner("https://www.github.com/Foo/bar")).toBe("foo");
    expect(githubOwner("https://gitlab.com/foo/bar")).toBeNull();
  });

  it("packageNames drops language affixes, keeping names of ≥ 3 chars", () => {
    expect(packageNames("o/Node-Redis-JS")).toEqual(["node-redis-js", "node-redis", "redis-js", "redis"]);
    expect(packageNames("o/py-x")).toEqual(["py-x"]);
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
