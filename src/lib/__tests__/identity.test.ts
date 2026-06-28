import { describe, expect, it } from "vitest";
import { removeInferredIdentityClaims, sanitizeIdentityClaims } from "../identity";
import type { ScanResult } from "../types";

function scanWithIdentity(profile: {
  name?: string | null;
  bio?: string | null;
  company?: string | null;
}): ScanResult {
  return {
    metrics: {
      username: "sample-user",
      profile_url: null,
      avatar_url: null,
      name: profile.name ?? null,
      bio: profile.bio ?? null,
      company: profile.company ?? null,
    } as ScanResult["metrics"],
    top_repos: [],
    recent_prs: [],
    flood_pr_titles: [],
    scoring: {} as ScanResult["scoring"],
  };
}

describe("removeInferredIdentityClaims", () => {
  it("downgrades inferred Apache committer claims", () => {
    expect(removeInferredIdentityClaims("自称 Apache Committer，给项目补了文档")).toBe(
      "给 Apache 相关仓库提过 PR，给项目补了文档",
    );
    expect(removeInferredIdentityClaims("Apache Committer energy")).toBe(
      "Apache related repo contributor energy",
    );
  });

  it("downgrades inferred identity claims for other organizations", () => {
    expect(removeInferredIdentityClaims("Facebook Maintainer vibes")).toBe(
      "Facebook related repo contributor vibes",
    );
    expect(removeInferredIdentityClaims("React Core Team cosplay")).toBe(
      "React related repo contributor cosplay",
    );
    expect(removeInferredIdentityClaims("Kubernetes 维护者，但证据只是 PR")).toBe(
      "Kubernetes 相关仓库贡献者，但证据只是 PR",
    );
  });

  it("downgrades fake or pseudo identity labels without hard-coding one community", () => {
    expect(removeInferredIdentityClaims("Fake Meta Maintainer")).toBe("Meta repo visitor");
    expect(removeInferredIdentityClaims("伪 React 核心成员")).toBe("React 仓库访客");
  });
});

describe("sanitizeIdentityClaims", () => {
  it("keeps title claims only when profile text explicitly provides the same identity", () => {
    const scan = scanWithIdentity({ bio: "Apache Committer" });
    const result = sanitizeIdentityClaims(
      scan,
      { zh: ["Apache Committer"], en: ["Apache Committer"] },
      { zh: "Apache Committer", en: "Apache Committer" },
      "Apache Committer",
    );
    expect(result.tags.en).toEqual(["Apache Committer"]);
    expect(result.report).toBe("Apache Committer");
  });

  it("still downgrades unrelated organization titles when profile has a generic title", () => {
    const scan = scanWithIdentity({ bio: "Open-source maintainer" });
    const result = sanitizeIdentityClaims(
      scan,
      { zh: ["Kubernetes 维护者"], en: ["Kubernetes Maintainer"] },
      { zh: "Kubernetes 维护者", en: "Kubernetes Maintainer" },
      "Kubernetes Maintainer",
    );
    expect(result.tags.en).toEqual(["Kubernetes related repo contributor"]);
    expect(result.report).toBe("Kubernetes related repo contributor");
  });
});
