import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/local.ts", "src/cli.ts", "src/bin.ts"],
  format: ["esm", "cjs"],
  dts: { entry: ["src/index.ts", "src/local.ts"] },
  clean: true,
  sourcemap: true,
  // ESM splitting keeps the devscore collector + engine in its own chunk so the
  // CLI only loads it when `score --local` is used (dynamic import in cli.ts).
  splitting: true,
  treeshake: true,
  target: "node22",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
