import type { FacetType } from "@/lib/facets";

export const DISCOVERY_FACET_TYPES = ["language", "repo", "org"] as const satisfies FacetType[];

export interface DiscoveryFacetRef {
  type: FacetType;
  value: string;
  reason?: string;
}

/**
 * The small contract future AI search can target: turn "I want to follow X"
 * into explicit facet filters first, then let the ranked directory resolve
 * matching developers.
 */
export interface DeveloperDiscoveryIntent {
  query: string;
  mode: "facet" | "semantic";
  facets: DiscoveryFacetRef[];
  minScore: number;
}

export const AI_DISCOVERY_LLM_MODES = ["byok", "server"] as const;
export type AiDiscoveryLlmMode = (typeof AI_DISCOVERY_LLM_MODES)[number];

export function resolveAiDiscoveryLlmMode(raw: string | undefined): AiDiscoveryLlmMode {
  return raw === "server" ? "server" : "byok";
}

export function estimateDiscoverySearchTokens(query: string, catalogItems = 1500) {
  const q = query.trim().length;
  const min = Math.ceil((900 + q / 3 + catalogItems * 4) / 500) * 500;
  const max = Math.ceil((1600 + q + catalogItems * 9) / 500) * 500;
  return { min, max };
}

export function facetPath(type: FacetType, value: string): string {
  return `/developers/${type}/${value
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")}`;
}

export function buildFacetDiscoveryIntent(
  query: string,
  facets: DiscoveryFacetRef[],
): DeveloperDiscoveryIntent {
  return {
    query: query.trim(),
    mode: "facet",
    facets,
    minScore: 60,
  };
}
