import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectProductTags } from "@/components/ProjectProductTags";
import {
  exposureBandLabel,
  productTagLabel,
  verificationLevelLabel,
  type ProductTag,
} from "../project-analysis-labels";

const tag: ProductTag = {
  slug: "local-first",
  labels: { zh: "本地优先", en: "Local-first" },
  evidence_ids: ["readme-contract"],
};

describe("project analysis labels", () => {
  it("selects Chinese labels only for Chinese locales", () => {
    expect(productTagLabel(tag, "zh-CN")).toBe("本地优先");
    expect(productTagLabel(tag, "en")).toBe("Local-first");
    expect(productTagLabel(tag, "ja")).toBe("Local-first");
  });

  it("turns internal verification and exposure values into product language", () => {
    expect(verificationLevelLabel("source_inspected", "zh-CN")).toBe("已检查源码");
    expect(exposureBandLabel("emerging", "zh-CN")).toBe("正在受到关注");
    expect(verificationLevelLabel("core_flow_executed", "en")).toBe(
      "Core flow verified",
    );
  });

  it("renders localized tags without exposing slugs", () => {
    const markup = renderToStaticMarkup(
      <ProjectProductTags tags={[tag]} locale="zh-CN" />,
    );

    expect(markup).toContain("本地优先");
    expect(markup).not.toContain("local-first");
  });

  it("renders nothing for legacy analyses without product tags", () => {
    expect(
      renderToStaticMarkup(<ProjectProductTags tags={[]} locale="zh-CN" />),
    ).toBe("");
  });
});
