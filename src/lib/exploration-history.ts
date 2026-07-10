export const EXPLORATION_HISTORY_KEY = "ghfind:exploration-history:v1";
export const EXPLORATION_HISTORY_LIMIT = 12;

export type ExplorationKind = "developer" | "project";

export interface ExplorationItem {
  kind: ExplorationKind;
  key: string;
  title: string;
  subtitle?: string;
  href: string;
  visitedAt: number;
}

export type ExplorationItemInput = Omit<ExplorationItem, "visitedAt"> & {
  visitedAt?: number;
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function canonicalPath(href: string) {
  const path = href.split(/[?#]/, 1)[0];
  return path.startsWith("/") ? path : "/";
}

function isExplorationItem(value: unknown): value is ExplorationItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ExplorationItem>;
  return (
    (item.kind === "developer" || item.kind === "project") &&
    typeof item.key === "string" &&
    item.key.length > 0 &&
    typeof item.title === "string" &&
    item.title.length > 0 &&
    typeof item.href === "string" &&
    item.href.startsWith("/") &&
    typeof item.visitedAt === "number" &&
    Number.isFinite(item.visitedAt)
  );
}

export function readExplorationHistory(storage = defaultStorage()): ExplorationItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(EXPLORATION_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(isExplorationItem).slice(0, EXPLORATION_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function recordExplorationItem(
  item: ExplorationItemInput,
  storage = defaultStorage(),
  visitedAt = Date.now(),
) {
  if (!storage) return;
  try {
    const next: ExplorationItem = {
      ...item,
      href: canonicalPath(item.href),
      visitedAt,
    };
    const history = readExplorationHistory(storage).filter(
      (entry) => !(entry.kind === next.kind && entry.key === next.key),
    );
    storage.setItem(
      EXPLORATION_HISTORY_KEY,
      JSON.stringify([next, ...history].slice(0, EXPLORATION_HISTORY_LIMIT)),
    );
  } catch {
    // Private browsing and embedded browsers may deny localStorage access.
  }
}

export function visibleExplorationItems(
  items: ExplorationItem[],
  currentHref: string,
  limit = 4,
) {
  const currentPath = canonicalPath(currentHref);
  return items.filter((item) => canonicalPath(item.href) !== currentPath).slice(0, limit);
}
