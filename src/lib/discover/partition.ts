import type { DiscoverCard, DiscoverPartition, DiscoverTag } from "./types";

export const DISCOVER_PARTITIONS = [
  "all",
  "agent",
  "skill",
  "microservice",
  "sandbox",
] as const satisfies readonly DiscoverPartition[];

/** Slug / label / free-text cues for interest partitions. Scoring untouched. */
const PARTITION_CUES: Record<
  Exclude<DiscoverPartition, "all">,
  { slugs: readonly string[]; labels: readonly string[]; text: readonly string[] }
> = {
  agent: {
    slugs: [
      "agent",
      "ai-agent",
      "llm-agent",
      "autonomous-agent",
      "coding-agent",
      "multi-agent",
      "agents",
    ],
    labels: ["agent", "agents", "ai agent", "llm agent", "智能体", "代理"],
    text: [
      "agent",
      "agents",
      "ai agent",
      "llm agent",
      "coding agent",
      "autonomous agent",
      "multi-agent",
      "智能体",
      "代理协议",
    ],
  },
  skill: {
    slugs: [
      "skill",
      "skills",
      "claude-skill",
      "cursor-skill",
      "plugin",
      "extension",
      "neovim-plugin",
      "vscode-extension",
    ],
    labels: ["skill", "skills", "技能", "插件", "plugin", "extension", "扩展"],
    text: ["skill", "skills", "技能", "plugin", "plugins", "插件", "extension", "扩展"],
  },
  microservice: {
    slugs: [
      "microservice",
      "microservices",
      "micro-service",
      "micro-services",
      "service-mesh",
      "rpc-service",
    ],
    labels: ["microservice", "microservices", "micro service", "微服务", "服务网格"],
    text: [
      "microservice",
      "microservices",
      "micro-service",
      "micro service",
      "微服务",
      "service mesh",
      "服务网格",
    ],
  },
  sandbox: {
    slugs: [
      "sandbox",
      "sandboxed",
      "isolation",
      "secure-runtime",
      "wasm-sandbox",
      "isolated-runtime",
    ],
    labels: ["sandbox", "sandboxed", "沙盒", "隔离", "isolation"],
    text: [
      "sandbox",
      "sandboxed",
      "沙盒",
      "隔离沙盒",
      "isolated",
      "isolation",
      "secure runtime",
      "不可信",
    ],
  },
};

export function isDiscoverPartition(value: string): value is DiscoverPartition {
  return (DISCOVER_PARTITIONS as readonly string[]).includes(value);
}

export function cardMatchesPartition(
  card: DiscoverCard,
  partition: DiscoverPartition,
): boolean {
  if (partition === "all") return true;
  const cues = PARTITION_CUES[partition];
  if (tagsMatch(card.tags, cues.slugs, cues.labels)) return true;
  const haystack = `${card.hook} ${card.summary}`.toLowerCase();
  return cues.text.some((cue) => haystack.includes(cue.toLowerCase()));
}

export function filterCardsByPartition(
  cards: DiscoverCard[],
  partition: DiscoverPartition,
): DiscoverCard[] {
  if (partition === "all") return cards;
  return cards.filter((card) => cardMatchesPartition(card, partition));
}

function tagsMatch(
  tags: DiscoverTag[],
  slugs: readonly string[],
  labels: readonly string[],
): boolean {
  const slugSet = new Set(slugs.map((s) => s.toLowerCase()));
  const labelSet = new Set(labels.map((s) => s.toLowerCase()));
  for (const tag of tags) {
    const slug = tagSlug(tag.id);
    if (slug && slugSet.has(slug)) return true;
    const label = tag.label.trim().toLowerCase();
    if (label && (labelSet.has(label) || [...labelSet].some((cue) => label.includes(cue)))) {
      return true;
    }
  }
  return false;
}

/** `namespace:slug` or bare slug → slug for cue match. */
function tagSlug(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!trimmed) return "";
  const sep = trimmed.lastIndexOf(":");
  return sep >= 0 ? trimmed.slice(sep + 1) : trimmed;
}
