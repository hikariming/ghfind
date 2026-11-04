import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/local.ts", "src/cli.ts", "src/bin.ts"],
  format: ["esm", "cjs"],
  dts: { entry: ["src/index.ts", "src/local.ts"] },
  clean: true,
  sourcemap: true,
  // `@ghfind/scoring` is a source-only devDependency, so it is bundled (not a
  // runtime dependency). ESM splitting keeps it in its own chunk so the CLI only
  // loads it for `--verify` / `verify` (dynamic import in cli.ts).
  noExternal: ["@ghfind/scoring"],
  splitting: true,
  treeshake: true,
  target: "es2021",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
