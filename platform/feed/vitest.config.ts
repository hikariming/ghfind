import { readFileSync, readdirSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = readdirSync("../../migrations-feed")
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name,
    queries: readFileSync(`../../migrations-feed/${name}`, "utf8")
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean),
  }));
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          FEED_EXECUTOR_SECRET:
            "local-test-only-executor-key-32-characters-minimum",
          FEED_OPERATOR_SECRET:
            "local-test-only-operator-key-32-characters-minimum",
          FEED_BRIDGE_SECRET:
            "local-test-only-bridge-key-32-characters-minimum",
        },
      },
    }),
  ],
  test: { setupFiles: ["./tests/setup.ts"], fileParallelism: false },
});
