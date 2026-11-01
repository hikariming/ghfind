#!/usr/bin/env node
/**
 * Machine gate for AGENTS.md Frontend Stack Rules.
 * Fail closed: duplicate or substitute UI/icon/animation/state/drag/layout
 * libraries, a non-Nova components.json, or a missing owner prompt.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OWNER_FRONTEND_PROMPT =
  "前端提示词。优先复用成熟库、组件源代码可控、统一设计语言、严格限制重复依赖。再配合指定好各种库，就算 oneshot 也能出很不错的前端。UI 风格统一使用 shadcn/ui Nova；图标统一使用 Lucide；动画统一使用 Motion；布局库 react-resizable-panels；拖拽 dnd-kit；状态管理 Zustand。";

const UNIQUE_PACKAGES = [
  "lucide-react",
  "motion",
  "zustand",
  "react-resizable-panels",
  "@dnd-kit/core",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
  "@dnd-kit/modifiers",
  "@dnd-kit/accessibility",
  "@dnd-kit/dom",
];

const FORBIDDEN = new Map([
  ["react-icons", "icons: use lucide-react"],
  ["@heroicons/react", "icons: use lucide-react"],
  ["@heroicons/vue", "icons: use lucide-react"],
  ["@radix-ui/react-icons", "icons: use lucide-react"],
  ["@tabler/icons-react", "icons: use lucide-react"],
  ["phosphor-react", "icons: use lucide-react"],
  ["@phosphor-icons/react", "icons: use lucide-react"],
  ["@fortawesome/react-fontawesome", "icons: use lucide-react"],
  ["@fortawesome/fontawesome-svg-core", "icons: use lucide-react"],
  ["@iconify/react", "icons: use lucide-react"],
  ["react-feather", "icons: use lucide-react"],
  ["framer-motion", "animation: use motion"],
  ["react-spring", "animation: use motion"],
  ["@react-spring/web", "animation: use motion"],
  ["@react-spring/core", "animation: use motion"],
  ["gsap", "animation: use motion"],
  ["animejs", "animation: use motion"],
  ["lottie-react", "animation: use motion"],
  ["react-lottie", "animation: use motion"],
  ["@formkit/auto-animate", "animation: use motion"],
  ["jotai", "state: use zustand"],
  ["recoil", "state: use zustand"],
  ["redux", "state: use zustand"],
  ["@reduxjs/toolkit", "state: use zustand"],
  ["mobx", "state: use zustand"],
  ["mobx-react", "state: use zustand"],
  ["mobx-react-lite", "state: use zustand"],
  ["valtio", "state: use zustand"],
  ["xstate", "state: use zustand"],
  ["@xstate/react", "state: use zustand"],
  ["nanostores", "state: use zustand"],
  ["@nanostores/react", "state: use zustand"],
  ["react-beautiful-dnd", "drag: use @dnd-kit/*"],
  ["@hello-pangea/dnd", "drag: use @dnd-kit/*"],
  ["react-dnd", "drag: use @dnd-kit/*"],
  ["react-dnd-html5-backend", "drag: use @dnd-kit/*"],
  ["sortablejs", "drag: use @dnd-kit/*"],
  ["react-sortablejs", "drag: use @dnd-kit/*"],
  ["react-split", "layout: use react-resizable-panels"],
  ["react-split-pane", "layout: use react-resizable-panels"],
  ["allotment", "layout: use react-resizable-panels"],
  ["split.js", "layout: use react-resizable-panels"],
  ["react-resizable", "layout: use react-resizable-panels"],
  ["antd", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@ant-design/icons", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@mui/material", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@mui/icons-material", "icons: use lucide-react"],
  ["@chakra-ui/react", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@mantine/core", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@headlessui/react", "ui: use shadcn/ui Nova in src/components/ui"],
  ["primereact", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@fluentui/react", "ui: use shadcn/ui Nova in src/components/ui"],
  ["semantic-ui-react", "ui: use shadcn/ui Nova in src/components/ui"],
  ["react-bootstrap", "ui: use shadcn/ui Nova in src/components/ui"],
  ["bootstrap", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@nextui-org/react", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@heroui/react", "ui: use shadcn/ui Nova in src/components/ui"],
  ["styled-components", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@emotion/react", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@emotion/styled", "ui: use shadcn/ui Nova in src/components/ui"],
]);

const FORBIDDEN_PREFIXES = [
  ["@heroicons/", "icons: use lucide-react"],
  ["@mui/", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@chakra-ui/", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@mantine/", "ui: use shadcn/ui Nova in src/components/ui"],
  ["@fortawesome/", "icons: use lucide-react"],
  ["@emotion/", "ui: use shadcn/ui Nova in src/components/ui"],
];

function dependencyEntries(manifest) {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((key) =>
    Object.entries(manifest[key] ?? {}).map(([name, specifier]) => ({ key, name, specifier: String(specifier) })),
  );
}

function forbiddenReason(name) {
  if (FORBIDDEN.has(name)) return FORBIDDEN.get(name);
  const prefix = FORBIDDEN_PREFIXES.find(([p]) => name.startsWith(p));
  return prefix ? prefix[1] : null;
}

export function lockfilePackageVersions(lockfile) {
  const versions = new Map();
  const marker = lockfile.startsWith("packages:\n") ? 0 : lockfile.indexOf("\npackages:\n");
  const section = marker >= 0 ? lockfile.slice(marker).replace(/^\n?packages:\n/, "") : "";
  const re = /^ {2}(?:'([^']+)'|([^\s:]+)):/gm;
  for (const match of section.matchAll(re)) {
    const key = match[1] ?? match[2];
    if (!key || key.startsWith("@") && !key.includes("@", 1) && !key.includes("@", 1)) continue;
    const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
    if (at <= 0) continue;
    const name = key.slice(0, at);
    const version = key.slice(at + 1).replace(/\(.*$/, "");
    if (!version || version.startsWith("file:") || version.startsWith("link:")) continue;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

export function checkFrontendStack({
  manifests,
  lockfile = "",
  componentsJson,
  agentsMarkdown = "",
  claudeMarkdown = "",
  eslintSource = "",
} = {}) {
  const errors = [];
  for (const { path, json } of manifests ?? []) {
    for (const { name } of dependencyEntries(json ?? {})) {
      const reason = forbiddenReason(name);
      if (reason) errors.push(`${path}: forbidden package ${name} (${reason})`);
    }
    const dnd = dependencyEntries(json ?? {}).filter(({ name }) => name.startsWith("@dnd-kit/") || name === "dnd-kit");
    for (const { name } of dnd) {
      if (name !== "dnd-kit" && !name.startsWith("@dnd-kit/")) continue;
      if (name === "dnd-kit") errors.push(`${path}: use scoped @dnd-kit/* packages, not dnd-kit`);
    }
  }

  const specifiers = new Map();
  for (const { path, json } of manifests ?? []) {
    for (const { name, specifier } of dependencyEntries(json ?? {})) {
      if (!UNIQUE_PACKAGES.includes(name)) continue;
      if (!specifiers.has(name)) specifiers.set(name, []);
      specifiers.get(name).push({ path, specifier });
    }
  }
  for (const [name, found] of specifiers) {
    const unique = [...new Set(found.map((f) => f.specifier))];
    if (unique.length > 1) {
      errors.push(`${name} has multiple specifiers: ${found.map((f) => `${f.path}@${f.specifier}`).join(", ")}`);
    }
  }

  if (lockfile) {
    const versions = lockfilePackageVersions(lockfile);
    for (const name of UNIQUE_PACKAGES) {
      const set = versions.get(name);
      if (set && set.size > 1) errors.push(`lockfile has multiple ${name} versions: ${[...set].sort().join(", ")}`);
    }
  }

  if (!componentsJson) errors.push("components.json is required");
  else {
    if (componentsJson.style !== "radix-nova") {
      errors.push(`components.json style must be radix-nova (shadcn/ui Nova on Radix), got ${JSON.stringify(componentsJson.style)}`);
    }
    if (componentsJson.iconLibrary !== "lucide") {
      errors.push(`components.json iconLibrary must be lucide, got ${JSON.stringify(componentsJson.iconLibrary)}`);
    }
  }

  if (!agentsMarkdown) errors.push("AGENTS.md is required");
  else if (!agentsMarkdown.includes(OWNER_FRONTEND_PROMPT)) {
    errors.push("AGENTS.md is missing the owner Frontend Stack Rules prompt (verbatim)");
  }
  if (!claudeMarkdown) errors.push("CLAUDE.md is required");
  else if (!/AGENTS\.md/.test(claudeMarkdown)) {
    errors.push("CLAUDE.md must reference AGENTS.md");
  }
  if (!eslintSource) errors.push("eslint.config.mjs is required");
  else {
    for (const needle of ["no-restricted-imports", "framer-motion", "@radix-ui/", "lucide-react"]) {
      if (!eslintSource.includes(needle)) errors.push(`eslint.config.mjs must enforce ${needle}`);
    }
  }
  return errors;
}

export function collectWorkspaceManifests(root) {
  const manifests = [];
  const add = (rel) => {
    const full = join(root, rel);
    try {
      manifests.push({ path: rel, json: JSON.parse(readFileSync(full, "utf8")) });
    } catch {
      // optional workspace
    }
  };
  add("package.json");
  for (const dir of ["packages", "apps"]) {
    const base = join(root, dir);
    let names = [];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const rel = join(dir, name, "package.json");
      try {
        if (statSync(join(root, rel)).isFile()) add(rel);
      } catch {
        // skip
      }
    }
  }
  return manifests;
}

export function checkRepository(root) {
  const read = (rel) => {
    try {
      return readFileSync(join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const errors = [];
  const componentsRaw = read("components.json");
  let componentsJson;
  if (componentsRaw === null) errors.push("components.json is required");
  else {
    try {
      componentsJson = JSON.parse(componentsRaw);
    } catch {
      return [`components.json is not valid JSON`];
    }
  }
  const lockfile = read("pnpm-lock.yaml");
  if (lockfile === null) errors.push("pnpm-lock.yaml is required");
  const webAgents = read("apps/web/AGENTS.md");
  if (webAgents === null) errors.push("apps/web/AGENTS.md is required");
  else if (!/AGENTS\.md/.test(webAgents)) errors.push("apps/web/AGENTS.md must reference root AGENTS.md");
  errors.push(...checkFrontendStack({
    manifests: collectWorkspaceManifests(root),
    lockfile: lockfile ?? "",
    componentsJson,
    agentsMarkdown: read("AGENTS.md") ?? "",
    claudeMarkdown: read("CLAUDE.md") ?? "",
    eslintSource: read("eslint.config.mjs") ?? "",
  }));
  return errors;
}

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invoked) {
  const root = resolve(process.argv[2] ?? defaultRoot);
  const errors = checkRepository(root);
  if (errors.length) {
    console.error(`frontend stack check failed (${relative(defaultRoot, root) || "."}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("frontend stack check passed");
}
