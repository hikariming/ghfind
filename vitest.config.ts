import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the `@/` path alias (from tsconfig `paths`) so tests can import real
// modules by their alias, not only relative paths / mocks.
export default defineConfig({
  // Worker packages own workerd-backed configs and must not run in Node's
  // default pool. CI invokes each package's required contract suite explicitly.
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "platform/**", "scripts/feed-platform-*.test.mjs", "scripts/feed-operator.test.mjs", "scripts/feed-governance.test.mjs", "scripts/feed-snapshot*.test.mjs"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Runtime code imports the Workers-safe web client, which rejects the
      // `file:` URLs the test fixtures use. Tests run in Node, so map it back
      // to the Node client (a superset: file: plus every web scheme).
      "@libsql/client/web": "@libsql/client",
    },
  },
});
