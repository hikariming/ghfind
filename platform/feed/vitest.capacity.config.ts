import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["capacity/**/*.test.ts"],
    testTimeout: 300000,
    hookTimeout: 300000,
  },
});
