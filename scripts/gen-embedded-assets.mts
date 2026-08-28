/**
 * Embeds filesystem assets into importable JSON so server code never reads the
 * disk at runtime — Cloudflare Workers has no filesystem, and Vercel's ISR
 * revalidation re-runs loaders outside the build sandbox. Generates:
 *
 * - `src/generated/content-files.json` — every file under `content/` keyed by
 *   its content-relative path (consumed via `src/lib/content-files.ts`).
 * - `src/generated/embedded-assets.json` — card fonts, tier-emoji SVGs and the
 *   sponsor logos as base64, replacing the old `readFile` call sites.
 *
 * Output is committed; run `pnpm gen:assets` (also part of `dev`/`build`) after
 * touching `content/`, `public/tier-emoji/` or the card fonts.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const outDir = path.join(root, "src", "generated");
mkdirSync(outDir, { recursive: true });

// content/ → one flat map. ~1.3MB today; revisit R2 if it outgrows the bundle.
const contentDir = path.join(root, "content");
const files: Record<string, string> = {};
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else files[path.relative(contentDir, p).split(path.sep).join("/")] = readFileSync(p, "utf8");
  }
};
walk(contentDir);
writeFileSync(path.join(outDir, "content-files.json"), JSON.stringify(files));

const b64 = (p: string) => readFileSync(p).toString("base64");
const tierEmojiDir = path.join(root, "public", "tier-emoji");
const assets = {
  fonts: {
    interRegular: b64(path.join(root, "src/app/api/card/fonts/Inter-Regular.woff")),
    interExtraBold: b64(path.join(root, "src/app/api/card/fonts/Inter-ExtraBold.woff")),
  },
  tierEmoji: Object.fromEntries(
    readdirSync(tierEmojiDir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => [f.slice(0, -4), `data:image/svg+xml;base64,${b64(path.join(tierEmojiDir, f))}`]),
  ),
  sponsor: Object.fromEntries(
    ["/lobehub.png", "/lobehub-32.png"]
      .filter((f) => statSync(path.join(root, "public", f), { throwIfNoEntry: false }))
      .map((f) => [f, `data:image/png;base64,${b64(path.join(root, "public", f))}`]),
  ),
};
writeFileSync(path.join(outDir, "embedded-assets.json"), JSON.stringify(assets));

const kb = (o: object) => Math.round(JSON.stringify(o).length / 1024);
console.log(
  `generated src/generated: content-files.json ${kb(files)}KB (${Object.keys(files).length} files), embedded-assets.json ${kb(assets)}KB`,
);
