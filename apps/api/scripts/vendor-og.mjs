/**
 * Vendors Next's own `@vercel/og` edge build (the renderer behind `next/og`)
 * into .generated/og so the PNG card routes render with the exact same
 * satori/yoga/resvg as the legacy Next Worker — byte-identical images.
 *
 * One patch: the edge build fetches its Geist base font at module scope via
 * `fetch(new URL("./Geist-Regular.ttf", import.meta.url))`. Workers forbid
 * that (no global-scope fetch, no file URLs); the font is imported as a Data
 * module instead. The base font is always loaded, so it must be the real one.
 * Fails loudly if a Next upgrade changes the patched line.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../../package.json"));
const src = join(dirname(require.resolve("next/package.json")), "dist/compiled/@vercel/og");
const out = join(here, "../.generated/og");
mkdirSync(out, { recursive: true });

for (const file of ["resvg.wasm", "yoga.wasm", "Geist-Regular.ttf"]) copyFileSync(join(src, file), join(out, file));

const FONT_FETCH =
  /var fallbackFont = fetch\(\s*new URL\("\.\/Geist-Regular\.ttf", import\.meta\.url\)\s*\)\.then\(\(res\) => res\.arrayBuffer\(\)\);/g;
const code = readFileSync(join(src, "index.edge.js"), "utf8");
const matches = code.match(FONT_FETCH)?.length ?? 0;
if (matches !== 1) {
  throw new Error(`vendor-og: expected 1 module-scope font fetch in @vercel/og index.edge.js, found ${matches}`);
}
writeFileSync(
  join(out, "index.edge.js"),
  'import __vercelOgGeistFont from "./Geist-Regular.ttf";\n' +
    code.replace(FONT_FETCH, "var fallbackFont = Promise.resolve(__vercelOgGeistFont);"),
);
console.log(`vendor-og: ${src} -> ${out}`);
