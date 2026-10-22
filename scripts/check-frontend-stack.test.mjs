import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OWNER_FRONTEND_PROMPT,
  checkFrontendStack,
  checkRepository,
  lockfilePackageVersions,
} from "./check-frontend-stack.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(root, "scripts/check-frontend-stack.mjs");

function passFixture() {
  return {
    manifests: [{ path: "package.json", json: { dependencies: { "lucide-react": "^1.22.0" } } }],
    lockfile: "lockfileVersion: '9.0'\n\npackages:\n\n  lucide-react@1.22.0:\n    resolution: {}\n",
    componentsJson: { style: "radix-nova", iconLibrary: "lucide" },
    agentsMarkdown: `# title\n${OWNER_FRONTEND_PROMPT}\n`,
    claudeMarkdown: "Follow AGENTS.md",
    eslintSource: `no-restricted-imports framer-motion @radix-ui/ lucide-react`,
  };
}

test("current repository satisfies the frontend stack gate", () => {
  const errors = checkRepository(root);
  assert.deepEqual(errors, []);
  const output = execFileSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  assert.match(output, /frontend stack check passed/);
});

test("owner prompt is the exact required string", () => {
  assert.match(OWNER_FRONTEND_PROMPT, /shadcn\/ui Nova/);
  assert.match(OWNER_FRONTEND_PROMPT, /Lucide/);
  assert.match(OWNER_FRONTEND_PROMPT, /Motion/);
  assert.match(OWNER_FRONTEND_PROMPT, /react-resizable-panels/);
  assert.match(OWNER_FRONTEND_PROMPT, /dnd-kit/);
  assert.match(OWNER_FRONTEND_PROMPT, /Zustand/);
});

test("forbidden substitutes and UI kits fail closed", () => {
  for (const name of ["framer-motion", "react-icons", "jotai", "antd", "@hello-pangea/dnd", "react-split"]) {
    const errors = checkFrontendStack({
      ...passFixture(),
      manifests: [{ path: "package.json", json: { dependencies: { [name]: "1.0.0" } } }],
    });
    assert.ok(errors.some((e) => e.includes(name)), `expected a hit for ${name}, got ${errors.join("; ")}`);
  }
});

test("Nova style and lucide icon library are required", () => {
  const style = checkFrontendStack({ ...passFixture(), componentsJson: { style: "new-york", iconLibrary: "lucide" } });
  assert.ok(style.some((e) => /radix-nova/.test(e)));
  const icons = checkFrontendStack({ ...passFixture(), componentsJson: { style: "radix-nova", iconLibrary: "radix" } });
  assert.ok(icons.some((e) => /iconLibrary/.test(e)));
});

test("duplicate stack versions in the lockfile fail", () => {
  const lockfile = `packages:\n\n  motion@12.0.0:\n    resolution: {}\n\n  motion@11.0.0:\n    resolution: {}\n`;
  const versions = lockfilePackageVersions(lockfile);
  assert.deepEqual([...versions.get("motion")].sort(), ["11.0.0", "12.0.0"]);
  const errors = checkFrontendStack({ ...passFixture(), lockfile });
  assert.ok(errors.some((e) => /multiple motion versions/.test(e)));
});

test("peer-suffixed lockfile keys count as one version", () => {
  const lockfile = `packages:\n\n  lucide-react@1.22.0:\n    resolution: {}\n\n  lucide-react@1.22.0(react@19.2.4):\n    resolution: {}\n`;
  const versions = lockfilePackageVersions(lockfile);
  assert.deepEqual([...versions.get("lucide-react")], ["1.22.0"]);
  assert.deepEqual(checkFrontendStack({ ...passFixture(), lockfile }), []);
});

test("missing owner prompt or eslint bans fail", () => {
  const prompt = checkFrontendStack({ ...passFixture(), agentsMarkdown: "# empty" });
  assert.ok(prompt.some((e) => /owner Frontend Stack Rules/.test(e)));
  const eslint = checkFrontendStack({ ...passFixture(), eslintSource: "export default []" });
  assert.ok(eslint.some((e) => /eslint.config.mjs/.test(e)));
});

test("missing required instruction files fail closed", () => {
  const temporary = mkdtempSync(join(tmpdir(), "frontend-stack-missing-"));
  try {
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ dependencies: {} }));
    assert.throws(
      () => execFileSync(process.execPath, [checker, temporary], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      /AGENTS\.md is required/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a workspace with a banned direct dependency is rejected from disk", () => {
  const temporary = mkdtempSync(join(tmpdir(), "frontend-stack-"));
  try {
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ dependencies: { "framer-motion": "11.0.0" } }));
    writeFileSync(join(temporary, "components.json"), JSON.stringify({ style: "radix-nova", iconLibrary: "lucide" }));
    writeFileSync(join(temporary, "AGENTS.md"), OWNER_FRONTEND_PROMPT);
    writeFileSync(join(temporary, "CLAUDE.md"), "See AGENTS.md");
    writeFileSync(join(temporary, "eslint.config.mjs"), "no-restricted-imports framer-motion @radix-ui/ lucide-react");
    mkdirSync(join(temporary, "apps/web"), { recursive: true });
    assert.throws(
      () => execFileSync(process.execPath, [checker, temporary], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      /framer-motion/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
