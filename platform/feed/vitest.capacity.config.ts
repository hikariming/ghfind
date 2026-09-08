import { defineConfig } from "vitest/config";
import { execFileSync } from "node:child_process";
import base from "./vitest.config.ts";
export default defineConfig({
  ...base,
  define: {
    __CAPACITY_IMPLEMENTATION_SHA__: JSON.stringify(
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ),
  },
  test: {
    ...base.test,
    include: ["capacity/**/*.test.ts"],
    testTimeout: 300000,
    hookTimeout: 300000,
  },
});
