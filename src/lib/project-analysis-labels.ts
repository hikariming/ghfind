import type {
  ExposureBand,
  ProjectAnalysisArtifact,
  VerificationLevel,
} from "./project-analysis-contract";

export type ProductTag = ProjectAnalysisArtifact["project"]["product_tags"][number];

const EXPOSURE_LABELS: Record<"zh" | "en", Record<ExposureBand, string>> = {
  zh: {
    unknown: "曝光未知",
    low: "曝光较低",
    emerging: "正在受到关注",
    established: "已有稳定关注",
    mainstream: "广泛关注",
  },
  en: {
    unknown: "Unknown exposure",
    low: "Low exposure",
    emerging: "Emerging",
    established: "Established",
    mainstream: "Mainstream",
  },
};

const VERIFICATION_LABELS: Record<"zh" | "en", Record<VerificationLevel, string>> = {
  zh: {
    metadata_only: "已核对项目信息",
    source_inspected: "已检查源码",
    built: "已完成构建",
    core_flow_executed: "已验证核心流程",
  },
  en: {
    metadata_only: "Project information checked",
    source_inspected: "Source inspected",
    built: "Build completed",
    core_flow_executed: "Core flow verified",
  },
};

function displayLanguage(locale: string): "zh" | "en" {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function productTagLabel(tag: ProductTag, locale: string): string {
  return tag.labels[displayLanguage(locale)];
}

export function exposureBandLabel(band: ExposureBand, locale: string): string {
  return EXPOSURE_LABELS[displayLanguage(locale)][band];
}

export function verificationLevelLabel(
  level: VerificationLevel,
  locale: string,
): string {
  return VERIFICATION_LABELS[displayLanguage(locale)][level];
}
