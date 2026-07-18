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

  it("renders a 2x Chinese material card with print-size metadata", () => {
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

    expect(svg).toContain('width="1824" height="1200"');
    expect(svg).toContain('data-print-width="76mm" data-print-height="50mm"');
    expect(svg).not.toContain("六维能力");
    expect(svg).toContain("账号成熟");
    expect(svg).toContain('x="48" y="255"');
    expect(svg).toContain('x="52" y="348"');
    expect(svg).toContain('x="52" y="400"');
    expect(svg).toContain("#全栈造物主");
    expect(svg).not.toContain("#十年老兵");
    expect(svg.match(/<rect x="[^"]+" y="445"/g)).toHaveLength(3);
    expect(svg).toContain('<rect x="48" y="445"');
    expect(svg).not.toContain('y="402"');
    expect(svg).toContain('height="40" rx="20"');
    expect(svg).toContain('font-size="22" font-weight="700"');
    expect(svg).toContain(
      'fill="#000000" stroke="#f59e0b" stroke-width="1.5"',
    );
    expect(svg).toContain(
      '<image href="data:image/svg+xml;base64,crown" x="91" y="24" width="34" height="34"/>',
    );
    expect(svg).toContain('<clipPath id="material-avatar-clip"><circle cx="108" cy="101" r="55"/></clipPath>');
    expect(svg).toContain('<circle cx="108" cy="101" r="60"');
    expect(svg).toContain('<text x="178" y="98" fill="#f59e0b" font-size="42" font-weight="800">@codex-showcase</text>');
    expect(svg).toContain('<text x="178" y="136" fill="#d4d4d8" font-size="29">Codex Showcase</text>');
    expect(svg).toContain("封神 · 殿堂级标杆");
    expect(svg.match(/ghfind\.com/g)).toHaveLength(1);
    expect(svg).toContain("Powered by Lubehub, Dify and Mosoo.");
    expect(svg).toContain('data-decoration="ghfind-watermark"');
    expect(svg).toContain('stop-color="#f59e0b" stop-opacity="0.5"');
    expect(svg).toContain('flood-color="#f59e0b" flood-opacity="0.42"');
    expect(svg).toContain('data-decoration="ghfind-watermark" opacity="0.14"');
    expect(svg).toContain('id="material-glow-opposite"');
    expect(svg).toContain(
      '<stop offset="1" stop-color="#f59e0b" stop-opacity="0.12"/>',
    );
    expect(svg).not.toContain('data-decoration="play-watermark"');
    expect(svg).toContain("GitHub 开发者实力认证");
    expect(svg).toContain('font-size="94"');
    expect(svg).toContain('font-size="74"');
    expect(svg).toContain('font-size="28" font-weight="600"');
    expect(svg).toContain('font-size="22" font-weight="600"');
    expect(svg).toContain('font-size="33" font-weight="800"');
    expect(svg).toContain(
      'data-dimension-label="account_maturity"><text x="688.0" y="168.0" text-anchor="middle" dominant-baseline="middle"',
    );
    expect(svg).toContain(
      'data-dimension-label="original_project_quality"><text x="795.4" y="230.0" text-anchor="middle" dominant-baseline="middle"',
    );
    expect(svg).toContain(
      'data-dimension-label="contribution_quality"><text x="795.4" y="354.0" text-anchor="middle" dominant-baseline="middle"',
    );
    expect(svg).toContain(
      'data-dimension-label="ecosystem_impact"><text x="688.0" y="416.0" text-anchor="middle" dominant-baseline="middle"',
    );
    expect(svg).toContain(
      'data-dimension-label="community_influence"><text x="580.6" y="354.0" text-anchor="middle" dominant-baseline="middle"',
    );
    expect(svg).toContain(
      'data-dimension-label="activity_authenticity"><text x="580.6" y="230.0" text-anchor="middle" dominant-baseline="middle"',
    );
    expect(svg).toContain(
      '<text x="795.4" y="190.0" text-anchor="middle" dominant-baseline="middle" fill="#d4d4d8" font-size="22" font-weight="600">原创质量</text>',
    );
    expect(svg).toContain(
      '<text x="795.4" y="394.0" text-anchor="middle" dominant-baseline="middle" fill="#d4d4d8" font-size="22" font-weight="600">贡献质量</text>',
    );
    expect(svg).toContain(
      '<text x="580.6" y="394.0" text-anchor="middle" dominant-baseline="middle" fill="#d4d4d8" font-size="22" font-weight="600">社区影响</text>',
    );
    expect(svg).toContain(
      '<text x="580.6" y="190.0" text-anchor="middle" dominant-baseline="middle" fill="#d4d4d8" font-size="22" font-weight="600">活跃真实</text>',
    );
    expect(svg).toContain('font-size="42" font-weight="800"');
    expect(svg).toContain('font-size="29">Codex Showcase</text>');
    expect(svg).toContain('x="240" y="553" fill="#d4d4d8" font-size="20">GitHub 开发者实力认证</text>');
    expect(svg).toContain('font-size="27" font-weight="800">ghfind.com</text>');
    expect(svg).toContain("data:image/png;base64,qr");
    expect(svg).not.toContain("/100");
    expect(svg).not.toContain("this week");
  });
});
