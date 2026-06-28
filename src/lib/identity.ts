import type { RoastLine, ScanResult, Tags } from "@/lib/types";

type IdentityProfile = Pick<ScanResult["metrics"], "name" | "bio" | "company">;

const LATIN_ORG = String.raw`[A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*){0,3}`;
const EN_IDENTITY_TITLE = String.raw`Committer|Maintainer|Core\s+Team(?:\s+Member)?|Core\s+Maintainer|Project\s+Member|Team\s+Member`;
const ZH_IDENTITY_TITLE = String.raw`Committer|Maintainer|Core\s+Team|核心成员|核心维护者|维护者|项目成员|团队成员`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExplicitIdentityFor(profile: IdentityProfile | undefined, org: string, title: string): boolean {
  if (!profile) return false;
  const text = [profile.name, profile.bio, profile.company].filter(Boolean).join(" ");
  if (!text) return false;
  const orgPattern = escapeRegExp(org).replace(/\s+/g, String.raw`\s+`);
  const titlePattern = escapeRegExp(title).replace(/\s+/g, String.raw`\s+`);
  return (
    new RegExp(String.raw`\b${orgPattern}\b.{0,32}\b${titlePattern}\b`, "i").test(text) ||
    new RegExp(String.raw`\b${titlePattern}\b.{0,32}(?:@|\b)${orgPattern}\b`, "i").test(text)
  );
}

function hasAnyExplicitIdentity(profile: IdentityProfile | undefined, title: string): boolean {
  if (!profile) return false;
  const text = [profile.name, profile.bio, profile.company].filter(Boolean).join(" ");
  if (!text) return false;
  const titlePattern = escapeRegExp(title).replace(/\s+/g, String.raw`\s+`);
  return new RegExp(String.raw`\b${titlePattern}\b`, "i").test(text);
}

export function removeInferredIdentityClaims(text: string, profile?: IdentityProfile): string {
  return text
    .replace(
      new RegExp(String.raw`自称\s*(${LATIN_ORG})\s*(?:${ZH_IDENTITY_TITLE})[，,]?\s*`, "gi"),
      "给 $1 相关仓库提过 PR，",
    )
    .replace(
      new RegExp(String.raw`伪\s*(${LATIN_ORG})\s*(?:Co|${ZH_IDENTITY_TITLE}|贡献者)`, "gi"),
      "$1 仓库访客",
    )
    .replace(
      new RegExp(String.raw`\b(?:Fake|Pseudo)\s+(${LATIN_ORG})\s+(?:${EN_IDENTITY_TITLE})\b`, "gi"),
      "$1 repo visitor",
    )
    .replace(
      new RegExp(String.raw`\b(${LATIN_ORG})\s+(${EN_IDENTITY_TITLE})\b`, "gi"),
      (match: string, org: string, title: string) =>
        hasExplicitIdentityFor(profile, org, title) ? match : `${org} related repo contributor`,
    )
    .replace(
      new RegExp(String.raw`(${LATIN_ORG})\s*(${ZH_IDENTITY_TITLE})`, "gi"),
      (match: string, org: string, title: string) =>
        hasExplicitIdentityFor(profile, org, title) ? match : `${org} 相关仓库贡献者`,
    )
    .replace(/\bFake Committer\b/gi, "Repo Visitor")
    .replace(/\bCommitter\b/g, (match: string) =>
      hasAnyExplicitIdentity(profile, match) ? match : "Contributor",
    );
}

export function sanitizeIdentityClaims(
  scan: ScanResult,
  tags: Tags,
  roastLine: RoastLine,
  report: string,
): { tags: Tags; roastLine: RoastLine; report: string } {
  return {
    tags: {
      zh: tags.zh.map((tag) => removeInferredIdentityClaims(tag, scan.metrics)),
      en: tags.en.map((tag) => removeInferredIdentityClaims(tag, scan.metrics)),
    },
    roastLine: {
      zh: removeInferredIdentityClaims(roastLine.zh, scan.metrics),
      en: removeInferredIdentityClaims(roastLine.en, scan.metrics),
    },
    report: removeInferredIdentityClaims(report, scan.metrics),
  };
}
