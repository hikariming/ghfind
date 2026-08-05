import type {
  ExposureBand,
  ProjectAnalysisArtifact,
  VerificationLevel,
} from "./project-analysis-contract";

export type ProductTag = ProjectAnalysisArtifact["project"]["product_tags"][number];
export type ProjectRisk = ProjectAnalysisArtifact["risks"][number];

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

const RISK_SEVERITY_LABELS: Record<"zh" | "en", Record<ProjectRisk["severity"], string>> = {
  zh: { info: "提示", low: "低", medium: "中", high: "高", critical: "严重" },
  en: { info: "Info", low: "Low", medium: "Medium", high: "High", critical: "Critical" },
};

const RISK_CATEGORY_LABELS: Record<"zh" | "en", Record<ProjectRisk["category"], string>> = {
  zh: {
    license: "许可证",
    security: "安全",
    supply_chain: "供应链",
    maintenance: "维护",
    compatibility: "兼容性",
    privacy: "隐私",
    operations: "运维",
    other: "其他",
  },
  en: {
    license: "License",
    security: "Security",
    supply_chain: "Supply chain",
    maintenance: "Maintenance",
    compatibility: "Compatibility",
    privacy: "Privacy",
    operations: "Operations",
    other: "Other",
  },
};

export function riskSeverityLabel(severity: ProjectRisk["severity"], locale: string): string {
  return RISK_SEVERITY_LABELS[displayLanguage(locale)][severity];
}

export function riskCategoryLabel(category: ProjectRisk["category"], locale: string): string {
  return RISK_CATEGORY_LABELS[displayLanguage(locale)][category];
}
