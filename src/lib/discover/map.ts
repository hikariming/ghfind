import type { FeedPage, FeedProject } from "@/lib/feed";
import type { ProjectAssessment } from "@/lib/project-analysis-db";
import { productTagLabel } from "@/lib/project-analysis-labels";
import { discoverHook } from "./hook";
import type { DiscoverCard, DiscoverPage } from "./types";

export function splitRepoKey(repoKey: string): { ownerLogin: string; name: string } {
  const normalized = repoKey.trim().toLowerCase();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) {
    return { ownerLogin: normalized, name: normalized };
  }
  return { ownerLogin: normalized.slice(0, separator), name: normalized.slice(separator + 1) };
}

export function cardFromFeedProject(
  project: FeedProject,
  impressionToken: string,
  locale: string,
): DiscoverCard {
  const { ownerLogin, name } = splitRepoKey(project.repoKey);
  const useZh = locale.toLowerCase().startsWith("zh");
  return {
    repoKey: project.repoKey.toLowerCase(),
    ownerLogin: project.ownerLogin || ownerLogin,
    name: project.name || name,
    summary: project.summary,
    hook: discoverHook({ name: project.name || name, summary: project.summary }),
    audience: null,
    coverUrl: null,
    language: project.language,
    tags: project.tags.slice(0, 5).map((tag) => ({
      id: tag.id,
      label: useZh ? tag.labelZh : tag.labelEn,
    })),
    productScore: project.productScore,
    confidence: project.confidence,
    communityStrength: null,
    canonicalUrl: project.canonicalUrl,
    analysisId: null,
    impressionToken,
    source: "feed",
    verificationLevel: project.verificationLevel,
  };
}

export function cardFromAssessment(assessment: ProjectAssessment, locale: string): DiscoverCard {
  const { ownerLogin, name } = splitRepoKey(assessment.repoKey);
  return {
    repoKey: assessment.repoKey.toLowerCase(),
    ownerLogin,
    name,
    summary: assessment.analysis.project.summary,
    hook: discoverHook({
      name,
      summary: assessment.analysis.project.summary,
      pain: assessment.analysis.project.pain_statement,
    }),
    audience: assessment.analysis.project.target_users[0] ?? null,
    coverUrl: null,
    language: null,
    tags: assessment.analysis.project.product_tags.map((tag) => ({
      id: "namespace" in tag ? `${tag.namespace}:${tag.slug}` : tag.slug,
      label: productTagLabel(tag, locale),
    })),
    productScore: assessment.productScore,
    confidence: assessment.confidence,
    communityStrength: assessment.communityStrength,
    canonicalUrl: assessment.analysis.repository.canonical_url,
    analysisId: assessment.latestAnalysisId,
    impressionToken: null,
    source: "public",
    verificationLevel: assessment.verificationLevel,
  };
}

export function pageFromFeed(page: FeedPage, locale: string): DiscoverPage {
  return {
    items: page.items.map((item) => cardFromFeedProject(item.project, item.impressionToken, locale)),
    nextCursor: page.nextCursor,
    nextOffset: null,
    source: "feed",
    degraded: page.degraded,
    requestId: page.requestId,
  };
}

export function dedupeCards(existing: DiscoverCard[], incoming: DiscoverCard[]): DiscoverCard[] {
  const seen = new Set(existing.map((card) => card.repoKey));
  const extra = incoming.filter((card) => {
    if (seen.has(card.repoKey)) return false;
    seen.add(card.repoKey);
    return true;
  });
  return [...existing, ...extra];
}
