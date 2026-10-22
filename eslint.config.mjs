import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const frontendStackBans = {
  paths: [
    { name: "framer-motion", message: "Use motion. Do not add framer-motion." },
    { name: "react-icons", message: "Use lucide-react for icons." },
    { name: "jotai", message: "Use zustand for state." },
    { name: "recoil", message: "Use zustand for state." },
    { name: "redux", message: "Use zustand for state." },
    { name: "@reduxjs/toolkit", message: "Use zustand for state." },
    { name: "mobx", message: "Use zustand for state." },
    { name: "valtio", message: "Use zustand for state." },
    { name: "antd", message: "Use shadcn/ui Nova components in src/components/ui." },
    { name: "@mui/material", message: "Use shadcn/ui Nova components in src/components/ui." },
    { name: "@chakra-ui/react", message: "Use shadcn/ui Nova components in src/components/ui." },
    { name: "@mantine/core", message: "Use shadcn/ui Nova components in src/components/ui." },
    { name: "react-beautiful-dnd", message: "Use @dnd-kit/* for drag." },
    { name: "@hello-pangea/dnd", message: "Use @dnd-kit/* for drag." },
    { name: "react-dnd", message: "Use @dnd-kit/* for drag." },
    { name: "react-split", message: "Use react-resizable-panels for layout." },
    { name: "styled-components", message: "Use shadcn/ui Nova + Tailwind." },
  ],
  patterns: [
    { group: ["framer-motion", "framer-motion/*"], message: "Use motion. Do not add framer-motion." },
    { group: ["react-icons", "react-icons/*"], message: "Use lucide-react for icons." },
    { group: ["jotai", "jotai/*"], message: "Use zustand for state." },
    { group: ["@heroicons/*"], message: "Use lucide-react for icons." },
    { group: ["@fortawesome/*"], message: "Use lucide-react for icons." },
    { group: ["@mui/*"], message: "Use shadcn/ui Nova components in src/components/ui." },
    { group: ["@chakra-ui/*"], message: "Use shadcn/ui Nova components in src/components/ui." },
    { group: ["@mantine/*"], message: "Use shadcn/ui Nova components in src/components/ui." },
    { group: ["@emotion/*"], message: "Use shadcn/ui Nova + Tailwind." },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...frontendStackBans,
          patterns: [
            ...frontendStackBans.patterns,
            {
              group: ["@radix-ui/*"],
              message:
                "Wrap Radix primitives in src/components/ui (shadcn/ui Nova). Feature code imports @/components/ui only.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/components/ui/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", frontendStackBans],
    },
  },
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
    "platform/**/worker-configuration.d.ts",
    "platform/**/dist/**",
    "platform/**/.wrangler/**",
    "platform/**/node_modules/**",
    // Astro migration apps: build output and generated types.
    "apps/*/dist/**",
    "apps/*/.astro/**",
    "apps/*/.wrangler/**",
    "apps/*/.generated/**",
  ]),
]);

export default eslintConfig;
