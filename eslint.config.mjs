import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Treat `_`-prefixed bindings and destructured rest-siblings as intentional
  // (e.g. `const { drop: _omit, ...rest } = obj` to strip a key).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloudflare/OpenNext build output and the embedded-asset JSON (the content
    // map is ~1MB of generated data; linting it OOMs eslint).
    ".open-next/**",
    ".wrangler/**",
    "src/generated/**",
    // Local-only noise: stale worktrees and scratch scripts (absent in CI).
    ".worktrees/**",
    "tmp/**",
  ]),
]);

export default eslintConfig;
