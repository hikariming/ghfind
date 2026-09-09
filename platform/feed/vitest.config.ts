import { readFileSync, readdirSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { unstable_splitSqlQuery } from "wrangler";

const migrationsFrom = (directory: string) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      queries: unstable_splitSqlQuery(
        readFileSync(`${directory}/${name}`, "utf8"),
      ),
    }));
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrationsFrom("../../migrations-feed"),
          TEST_CORE_MIGRATIONS: migrationsFrom("../../migrations"),
          FEED_DELIVERY_SECRET:
            "local-test-only-delivery-key-32-characters-minimum",
          FEED_EXECUTOR_SECRET:
            "local-test-only-executor-key-32-characters-minimum",
          FEED_OPERATOR_SECRET:
            "local-test-only-operator-key-32-characters-minimum",
          FEED_BRIDGE_SECRET:
            "local-test-only-bridge-key-32-characters-minimum",
          FEED_SOURCE_SECRET:
            "local-source-test-key-separate-32-characters-minimum",
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
  },
});
