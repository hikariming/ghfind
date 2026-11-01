import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import zh from "@/messages/zh.json";
import en from "@/messages/en.json";
import { describe, expect, it } from "vitest";
import { RoastReport, elementTag } from "@/components/RoastReport";

const SAMPLE = `## LofiSu — Lv.54  ·  元婴 (元婴初成 · 自成一派)

**称号**: 对话前台修理师

> **一句话结论**
>
> 合作价值在前台体验。

### 笑点三连

1. **双滚动条猎手**

   ant-design/x 这一笔专治两条滚动条。

2. **气泡贴边校正**

   hetaoBackend/deer-flow 修了上传文件右对齐。

3. **官网示例布置**

   apache/fory-site 补进 Scala 示例。

### 维度评分

#### 账号成熟度 · 6/10

原创仓库已经铺开。

#### 贡献质量 · 12/27

合入集中在对话前台。

**风险标记**：无

### 建议

- 把招聘技能做成可安装包。
- 给浏览器 MCP 补仓库描述。
`;

function renderReport(markdown: string, tier: "NPC" = "NPC", locale: "zh" | "en" = "zh") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <RoastReport markdown={markdown} tier={tier} />
    </NextIntlClientProvider>,
  );
}

describe("RoastReport compact layout", () => {
  it("renders dimension cards and finding chips from 笑点三连 loose lists", () => {
    const html = renderReport(SAMPLE);
    expect(html).toContain('data-tier-tone="npc"');
    expect(html).toContain('class="roast-dims"');
    expect(html).toContain('class="roast-dim-card"');
    expect(html).toContain('class="roast-dim-score"');
    expect(html).toContain('class="roast-dim-bar"');
    expect(html).toContain("账号成熟度");
    expect(html).toContain('class="roast-verdict');
    expect(html).toContain("小总评");
    expect(html).not.toContain("一句话结论");
    expect(html).toContain('class="roast-findings"');
    expect(html).toContain('class="roast-finding"');
    expect(html).toContain('class="roast-finding-title"');
    expect(html).toContain("双滚动条猎手");
    expect(html).toContain('class="roast-advice"');
    // Must not fall back to bare <li> for findings
    expect(html).not.toMatch(/<ol class="roast-findings">\s*<li>\s*<p/);
  });

  it("still parses legacy 扎心三连 after rewrite", () => {
    const legacy = SAMPLE.replace("笑点三连", "扎心三连");
    const html = renderReport(legacy);
    expect(html).toContain('class="roast-finding"');
    expect(html).toContain("双滚动条猎手");
  });

  it("elementTag ignores minified function.name and uses hast tagName", () => {
    // Simulate a production-minified custom component: .name is "n", no useful identity.
    function n(_props: { node?: { tagName?: string }; children?: ReactNode }) {
      return null;
    }
    Object.defineProperty(n, "name", { value: "n" });
    const withHast = {
      type: n,
      props: { node: { tagName: "strong" }, children: "双滚动条猎手" },
    } as unknown as ReactElement;
    expect(elementTag(withHast)).toBe("strong");

    const mangledOnly = {
      type: n,
      props: { children: "nope" },
    } as unknown as ReactElement;
    // Without hast tagName or displayName, must NOT invent a tag from .name
    expect(elementTag(mangledOnly)).toBeNull();
  });

  it("elementTag falls back to explicit displayName, never function.name", () => {
    function n(_props: { children?: ReactNode }) {
      return null;
    }
    Object.defineProperty(n, "name", { value: "n" });
    (n as { displayName?: string }).displayName = "p";
    const el = {
      type: n,
      props: { children: "title" },
    } as unknown as ReactElement;
    expect(elementTag(el)).toBe("p");
  });

  it("chips still render when custom component .name is mangled but displayName is set", () => {
    // Prove displayName survives as the production-safe identity for our wrappers.
    function n({ children }: { children?: ReactNode }) {
      return createElement("strong", { className: "roast-strong" }, children);
    }
    Object.defineProperty(n, "name", { value: "n" });
    (n as { displayName?: string }).displayName = "strong";
    expect(elementTag(createElement(n, { children: "x" } as never))).toBe("strong");
  });
});
