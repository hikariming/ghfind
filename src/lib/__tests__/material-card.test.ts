import { describe, expect, it } from "vitest";
import { gradeForDimension, renderMaterialCardSvg } from "../material-card";

const scores = {
  account_maturity: 9,
  original_project_quality: 14,
  contribution_quality: 16,
  ecosystem_impact: 9,
  community_influence: 3,
  activity_authenticity: 3,
};

describe("material card", () => {
  it("maps normalized dimension scores to A-E grades", () => {
    expect(gradeForDimension(8.5, 10)).toBe("A");
    expect(gradeForDimension(7, 10)).toBe("B");
    expect(gradeForDimension(5.5, 10)).toBe("C");
    expect(gradeForDimension(4, 10)).toBe("D");
    expect(gradeForDimension(3.9, 10)).toBe("E");
  });

  it("renders a Chinese 76 mm by 50 mm card without weekly score chrome", () => {
    const svg = renderMaterialCardSvg({
      username: "codex-showcase",
      displayName: "Codex Showcase",
      avatar: null,
      score: 96.8,
      tier: "夯",
      tierLabel: "封神 · 殿堂级标杆",
      tags: ["全栈造物主", "开源主程", "PR 收割机", "十年老兵"],
      scores,
      color: "#f59e0b",
      theme: "dark",
      qr: "data:image/png;base64,qr",
      tierIcon: "data:image/svg+xml;base64,crown",
    });

    expect(svg).toContain('width="76mm" height="50mm"');
    expect(svg).not.toContain("六维能力");
    expect(svg).toContain("账号成熟");
    expect(svg).toContain("#全栈造物主");
    expect(svg).toContain("#十年老兵");
    expect(svg.match(/<rect x="[^"]+" y="402"/g)).toHaveLength(3);
    expect(svg.match(/<rect x="[^"]+" y="446"/g)).toHaveLength(1);
    expect(svg).toContain(
      'fill="#f59e0b" fill-opacity="0.12" stroke="#f59e0b" stroke-opacity="0.48"',
    );
    expect(svg).toContain(
      '<image href="data:image/svg+xml;base64,crown" x="79" y="29" width="30" height="30"/>',
    );
    expect(svg).toContain("封神 · 殿堂级标杆");
    expect(svg.match(/ghfind\.com/g)).toHaveLength(1);
    expect(svg).toContain("Powered by Lubehub, Dify and Mosoo.");
    expect(svg).toContain('data-decoration="ghfind-watermark"');
    expect(svg).toContain('id="material-glow-opposite"');
    expect(svg).toContain(
      '<stop offset="1" stop-color="#f59e0b" stop-opacity="0.12"/>',
    );
    expect(svg).not.toContain('data-decoration="play-watermark"');
    expect(svg).toContain("GitHub 开发者实力认证");
    expect(svg).toContain('font-size="88"');
    expect(svg).toContain('font-size="68"');
    expect(svg).toContain('font-size="24" font-weight="600"');
    expect(svg).toContain("data:image/png;base64,qr");
    expect(svg).not.toContain("/100");
    expect(svg).not.toContain("this week");
  });
});
