import fs from "node:fs";
import path from "node:path";
import type { Tier } from "@/lib/types";

/**
 * Filesystem loader for curated collections ("editor's picks"). Each collection
 * lives in `content/collections/<slug>.json` — editorial copy carries zh + en
 * only and every other locale reads the en text (same policy as LLM content:
 * UI chrome is fully localized, long-form content is zh/en).
 *
 * Static phase: every item ships a `mock` stats block so the pages can be
 * previewed before DB wiring lands. The real-data phase resolves live stats
 * from `repos`/`scores` at render time and `mock` becomes a fallback for
 * entities the engine hasn't scanned yet.
 */

export type LocalizedText = { zh: string; en: string };

export type RepoPickStats = {
  stars: number;
  language?: string;
  description?: string;
  /** Average engine score of the scored contributors. */
  avgScore?: number;
  contributors?: { username: string; tier: Tier }[];
};

export type DeveloperPickStats = {
  name?: string;
  tier: Tier;
  score: number;
  followers?: number;
  totalStars?: number;
  languages?: string[];
};

export type CollectionItem =
  | { kind: "repo"; id: string; blurb: LocalizedText; mock: RepoPickStats }
  | { kind: "developer"; id: string; blurb: LocalizedText; mock: DeveloperPickStats };

export type CollectionType = "projects" | "developers" | "mixed";

export type Collection = {
  slug: string;
  type: CollectionType;
  title: LocalizedText;
  intro: LocalizedText;
  /** ISO date. */
  publishedAt: string;
  tags: string[];
  items: CollectionItem[];
};

const COLLECTIONS_DIR = path.join(process.cwd(), "content", "collections");

export function getCollectionSlugs(): string[] {
  if (!fs.existsSync(COLLECTIONS_DIR)) return [];
  return fs
    .readdirSync(COLLECTIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

export function getCollection(slug: string): Collection | null {
  // Slugs come from route params — refuse anything that could escape the dir.
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const file = path.join(COLLECTIONS_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as Collection;
  return { ...data, slug };
}

export function listCollections(): Collection[] {
  return getCollectionSlugs()
    .map((slug) => getCollection(slug))
    .filter((c): c is Collection => c !== null)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

/** Editorial copy ships zh + en; zh readers get zh, everyone else gets en. */
export function pickText(text: LocalizedText, locale: string): string {
  return locale === "zh" ? text.zh || text.en : text.en;
}
