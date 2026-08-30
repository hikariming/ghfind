/**
 * Virtual filesystem over `content/`, backed by the build-time embedding in
 * `src/generated/content-files.json` (see scripts/gen-embedded-assets.mts).
 * Replaces `node:fs` in the blog/collections loaders so they work on runtimes
 * without a disk (Cloudflare Workers) and during ISR revalidation.
 */
import files from "@/generated/content-files.json";

const CONTENT = files as Record<string, string>;

/** `readFileSync` equivalent; `path` is content-relative ("blog/<slug>/en.md"). */
export function readContentFile(path: string): string | null {
  return CONTENT[path] ?? null;
}

export function contentFileExists(path: string): boolean {
  return path in CONTENT;
}

/** Immediate child names of a content dir ("blog" → post slugs, "blog/x" → files). */
export function listContentDir(prefix: string): string[] {
  const seen = new Set<string>();
  const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
  for (const key of Object.keys(CONTENT)) {
    if (key.startsWith(p)) seen.add(key.slice(p.length).split("/")[0]);
  }
  return [...seen];
}
