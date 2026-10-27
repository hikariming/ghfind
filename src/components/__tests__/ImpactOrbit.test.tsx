import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImpactOrbit, impactRepoRowClassName } from "@/components/ImpactOrbit";

const format = (n: number) => {
  if (n >= 10_000) return `${(n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1)}万`;
  return String(n);
};

const sixRepos = [
  { repo: "org-alpha/flagship", stars: 160_000, commits: 3, prs: 3 },
  { repo: "org-beta/toolkit", stars: 12_000, commits: 1, prs: 1 },
  { repo: "org-gamma/runtime", stars: 4972, commits: 4, prs: 7 },
  { repo: "org-delta/console", stars: 4061, commits: 1, prs: 1 },
  { repo: "user-epsilon/site", stars: 1902, commits: 1, prs: 1 },
  { repo: "org-zeta/sdk", stars: 1744, commits: 1, prs: 1 },
];

describe("ImpactOrbit", () => {
  it("renders an orbit stage with upright planet links for up to six repos", () => {
    const html = renderToStaticMarkup(
      <ImpactOrbit
        repos={sixRepos}
        tier="顶级"
        formatStars={format}
        commitsLabel="commits"
        prsLabel="PRs"
        sectionTitle="Notable contributions"
      >
        <div data-avatar>avatar</div>
      </ImpactOrbit>,
    );

    expect(html).toContain('data-testid="impact-orbit-root"');
    expect(html).toContain('data-testid="impact-orbit-stage"');
    expect(html).toContain('data-testid="impact-orbit-spin"');
    expect(html).toContain('data-testid="impact-orbit-compact"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("Notable contributions");
    expect(html).toContain('href="https://github.com/org-alpha/flagship"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("org-alpha/flagship, ★ 16万, 3 commits · 3 PRs");
    expect(html).toContain("https://github.com/org-alpha.png?size=64");
    // large / medium / small planet sizes
    expect(html).toContain("width:30px");
    expect(html).toContain("width:24px");
    expect(html).toContain("width:18px");
    expect(html).toContain("data-avatar");
  });

  it("falls back to the avatar alone when there are no impact repos", () => {
    const html = renderToStaticMarkup(
      <ImpactOrbit
        repos={[]}
        tier="NPC"
        formatStars={format}
        commitsLabel="commits"
        prsLabel="PRs"
        sectionTitle="Notable contributions"
      >
        <div data-avatar>avatar</div>
      </ImpactOrbit>,
    );

    expect(html).toContain("data-avatar");
    expect(html).not.toContain('data-testid="impact-orbit-stage"');
    expect(html).not.toContain('data-testid="impact-orbit-spin"');
  });

  it("keeps a compact row ready for two impact repos", () => {
    const html = renderToStaticMarkup(
      <ImpactOrbit
        repos={[
          { repo: "org-alpha/lib", stars: 800, commits: 2, prs: 1 },
          { repo: "org-beta/app", stars: 200, commits: 0, prs: 1 },
        ]}
        tier="人上人"
        formatStars={format}
        commitsLabel="提交"
        prsLabel="PR"
        sectionTitle="贡献过的明星项目"
      >
        <span>ring</span>
      </ImpactOrbit>,
    );

    expect(html).toContain("org-alpha/lib, ★ 800, 2 提交 · 1 PR");
    expect(html).toContain("org-beta/app, ★ 200, 1 PR");
    expect(html).toContain('data-testid="impact-orbit-compact"');
  });

  it("exposes the prior impact row class for the featured-work disclosure", () => {
    expect(impactRepoRowClassName()).toContain("rounded-xl");
    expect(impactRepoRowClassName()).toContain("border-white/10");
  });
});
