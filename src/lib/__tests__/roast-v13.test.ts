import { afterEach, describe, expect, it, vi } from "vitest";
import { roastGenerator } from "../cache-version";
import { buildRoastPayload } from "../prompt";
import { coerceCopy, generateRoastV13, parseJsonObject, type V13Complete } from "../roast-v13/chain";
import { buildWriterFactCard, slimV13Payload } from "../roast-v13/facts";
import { renderV13Report } from "../roast-v13/render";
import { buildFactIndex, checkText, validateCopy, type V13Copy } from "../roast-v13/validate";
import type { ScanResult } from "../types";

const scan = {
  metrics: {
    username: "sample-user",
    account_age_years: 6.1,
    contribution_years_active: 7,
    followers: 44,
    following: 55,
    public_repos: 53,
    fork_repo_count: 34,
    merged_pr_count: 96,
    total_pr_count: 103,
    impact_pr_count: 58,
    impact_commit_count: 1191,
    impact_repo_count: 10,
    recent_merged_pr_sample: 50,
    last_year_contributions: 3611,
  },
  top_repos: [
    {
      name: "widget-kit",
      owner_login: "sample-user",
      name_with_owner: "sample-user/widget-kit",
      stars: 57,
      forks: 10,
      open_issues: 5,
      open_issue_count: 5,
      size: 2311,
      language: "TypeScript",
      description: "A lightweight component library",
      pushed_at: "2026-01-20T03:01:04Z",
      readme_excerpt: "long readme text that the writer never needs",
    },
    {
      name: "desk-agent",
      owner_login: "sample-user",
      name_with_owner: "sample-user/desk-agent",
      stars: 19,
      forks: 0,
      open_issues: 7,
      size: 900,
      language: "Rust",
      description: "Desktop agent",
      pushed_at: "2026-10-26T03:01:04Z",
    },
  ],
  recent_prs: [],
  impact_repos: [
    { repo: "popular-org/word-trainer", stars: 23551, prs: 1, commits: 1 },
    { repo: "sample-user/side-app", stars: 2, prs: 10, commits: 719 },
  ],
  verified_impact_prs: [],
  flood_pr_titles: [],
  scoring: {
    sub_scores: {
      account_maturity: 10,
      original_project_quality: 12.2,
      contribution_quality: 21.5,
      ecosystem_impact: 10,
      community_influence: 4,
      activity_authenticity: 15.9,
    },
    base_score: 73.6,
    red_flags: [],
    risk_notes: [],
    total_penalty: 0,
    final_score: 73.6,
    tier: "人上人",
    tier_label: "优质贡献者 · 值得信任",
  },
} as unknown as ScanResult;

const goodCopy = {
  title: "万星仓库只改两个词",
  roast_line: {
    zh: "23551 星的 popular-org/word-trainer 只收到你改的两个词条,719 个 commit 全留给了 2 星的 sample-user/side-app。",
    en: "A 23551-star repo got two word fixes; 719 commits went to a 2-star side app.",
  },
  roast_line_candidates: ["候选一", "候选二"],
  tags: { zh: ["词条外交", "粉丝倒挂"], en: ["Word Diplomat"] },
  verdict: "代码是真写,名气全靠别人家的仓库撑场。",
  findings: [
    { headline: "最贵的两个词", text: "popular-org/word-trainer 有 23551 星,你在那里只有 1 个 PR。" },
    { headline: "组件库下班了", text: "57 星的 sample-user/widget-kit 从 1 月起没再推送。" },
    { headline: "关注比粉丝勤快", text: "粉丝 44,关注 55。" },
  ],
  dimensions: {
    account_maturity: "注册 6.1 年,贡献跨 7 个自然年。",
    original_project_quality: "最高星 sample-user/widget-kit 57 星。",
    contribution_quality: "96 个合并 PR / 103 个总 PR。",
    ecosystem_impact: "1191 个 commit,719 个在 sample-user/side-app。",
    community_influence: "粉丝 44、关注 55。",
    activity_authenticity: "过去一年贡献日历 3611 次。",
  },
  risk: "",
  advice: ["给 sample-user/widget-kit 关掉那 5 个 open Issue。"],
};

const payload = slimV13Payload(buildRoastPayload(scan, "zh"));
const index = buildFactIndex(payload);

describe("roast v13 fact checks", () => {
  it("accepts numbers, derived shares and repos that exist in the payload", () => {
    expect(checkText(index, "x", "1191 个 commit 里 719 个在 sample-user/side-app,占 60%。")).toEqual([]);
    expect(checkText(index, "x", "粉丝 44 / 关注 55")).toEqual([]);
  });

  it("flags invented numbers and repositories", () => {
    const issues = checkText(index, "x", "你在 other-org/ghost 提了 4242 个 PR。");
    expect(issues.map((i) => i.kind).sort()).toEqual(["number", "repo"]);
  });

  it("flags a star count attached to the wrong repository", () => {
    const issues = checkText(index, "x", "1181 个 commit 埋在 sample-user/widget-kit 2 星的仓库里。");
    expect(issues.some((i) => i.kind === "repo_stars")).toBe(true);
    expect(checkText(index, "x", "sample-user/widget-kit 57 星")).toEqual([]);
  });

  it("reports template clichés", () => {
    const copy = coerceCopy({ ...goodCopy, verdict: "资历老到能当化石,这不等于作弊。" })!;
    const kinds = validateCopy(index, copy, "zh").filter((i) => i.kind === "cliche");
    expect(kinds.length).toBe(2);
  });

  it("keeps the writer fact card small and free of README bodies and output contracts", () => {
    const card = JSON.stringify(buildWriterFactCard(payload));
    expect(card).not.toContain("long readme text");
    expect(JSON.stringify(payload)).not.toContain("@@ADJUST");
    expect(card).toContain("sample-user/widget-kit");
  });
});

describe("roast v13 rendering", () => {
  it("renders scores from the scan, never from the model", () => {
    const copy = coerceCopy(goodCopy) as V13Copy;
    const md = renderV13Report(scan, "zh", copy);
    expect(md.startsWith("## sample-user — 73.60/100  ·  人上人 (优质贡献者 · 值得信任)")).toBe(true);
    expect(md).toContain("| 原创与主导项目质量 | 12.2/18 |");
    expect(md).toContain("**扎心三连**");
    expect(md).toContain("**风险标记**\n无。");
    const en = renderV13Report(scan, "en", copy);
    expect(en).toContain("SOLID (Solid · Trustworthy)");
    expect(en).toContain("| Account maturity | 10/10 |");
  });
});

function stub(outputs: Partial<Record<"angles" | "writer" | "editor", string | Error>>): V13Complete {
  return async (step) => {
    const out = outputs[step];
    if (out instanceof Error) throw out;
    return out ?? "";
  };
}

describe("roast v13 risk section", () => {
  it("falls back to the scorer's own notes without the disclaimer tail", () => {
    const risky = {
      ...scan,
      scoring: {
        ...scan.scoring,
        risk_notes: [{ flag: "mostly_forks", disposition: "note", detail: "公开仓库以 Fork 为主；这本身不代表任何问题。" }],
      },
    } as unknown as ScanResult;
    const md = renderV13Report(risky, "zh", { ...(coerceCopy(goodCopy) as V13Copy), risk: "" });
    expect(md).toContain("**风险标记**\n- 公开仓库以 Fork 为主（提示）");
    expect(md).not.toContain("不代表任何问题");
  });

  it("drops over-long tags instead of cutting them mid-word", () => {
    const copy = coerceCopy({ ...goodCopy, tags: { zh: ["短标签", "这是一个超过六个字的标签", "第二个"], en: [] } })!;
    expect(copy.tags.zh).toEqual(["短标签", "第二个"]);
  });
});

describe("generateRoastV13", () => {
  const opts = { deadlineMs: Date.now() + 600_000 };

  it("runs angle → writer → editor and returns rendered copy", async () => {
    const edited = { ...goodCopy, verdict: "编辑后的结论,真代码在 2 星仓库。" };
    const r = await generateRoastV13(
      scan,
      "zh",
      stub({ angles: '{"angles":[]}', writer: JSON.stringify(goodCopy), editor: "```json\n" + JSON.stringify(edited) + "\n```" }),
      opts,
    );
    expect(r.steps.map((s) => s.step)).toEqual(["angles", "writer", "editor"]);
    expect(r.report).toContain("编辑后的结论");
    expect(r.tags.zh).toEqual(["词条外交", "粉丝倒挂"]);
    expect(r.finalIssues.filter((i) => i.kind !== "cliche")).toEqual([]);
  });

  it("uses the draft when the editor fails and tolerates a failed angle step", async () => {
    const r = await generateRoastV13(
      scan,
      "zh",
      stub({ angles: new Error("boom"), writer: JSON.stringify(goodCopy), editor: new Error("timeout") }),
      opts,
    );
    expect(r.copy.verdict).toBe(goodCopy.verdict);
  });

  it("retries an empty writer once, then fails so the route can fall back", async () => {
    let writerCalls = 0;
    await expect(
      generateRoastV13(scan, "zh", async (step) => (step === "writer" ? (writerCalls++, "") : "{}"), opts),
    ).rejects.toThrow(/writer/);
    expect(writerCalls).toBe(2);
  });

  it("drops sentences that still cite facts absent from the data", async () => {
    const bad = {
      ...goodCopy,
      findings: [
        ...goodCopy.findings.slice(0, 2),
        { headline: "编造", text: "你在 other-org/ghost 有 9999 星。粉丝 44。" },
      ],
    };
    const r = await generateRoastV13(scan, "zh", stub({ writer: JSON.stringify(bad), editor: "not json" }), {
      ...opts,
      skipAngles: true,
    });
    expect(r.copy.findings[2].text).toBe("粉丝 44。");
    expect(r.dropped.length).toBe(1);
  });

  it("refuses to start a step without budget", async () => {
    await expect(
      generateRoastV13(scan, "zh", stub({}), { deadlineMs: Date.now() + 1000 }),
    ).rejects.toThrow(/budget/);
  });

  it("parses JSON objects wrapped in prose", () => {
    expect(parseJsonObject('ok {"a":1} done')).toEqual({ a: 1 });
    expect(parseJsonObject("nothing")).toBeNull();
  });
});

describe("roast generator flag", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to v12", () => {
    vi.stubEnv("ROAST_GENERATOR", "");
    expect(roastGenerator()).toBe("v12");
    expect(roastGenerator({ background: true })).toBe("v12");
  });

  it("uses v13 everywhere when enabled", () => {
    vi.stubEnv("ROAST_GENERATOR", "v13");
    expect(roastGenerator()).toBe("v13");
    expect(roastGenerator({ background: true })).toBe("v13");
  });

  it("can limit v13 to queued background re-roasts", () => {
    vi.stubEnv("ROAST_GENERATOR", "v13");
    vi.stubEnv("ROAST_V13_SCOPE", "background");
    expect(roastGenerator()).toBe("v12");
    expect(roastGenerator({ background: true })).toBe("v13");
  });
});
