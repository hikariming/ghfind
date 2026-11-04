# Light Theme Emerald Mapping Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Emerald domain-topic pills readable in the resolved light theme without changing their dark-theme appearance.

**Architecture:** Preserve the topic component's semantic Tailwind classes and extend the existing global `html[data-theme="light"]` compatibility mappings. Protect the two required mappings with a small source-level Vitest contract, then verify resolved themes in the browser.

**Tech Stack:** Next.js 16, Tailwind CSS 4, CSS, TypeScript, Vitest

---

### Task 1: Add a failing light-theme mapping contract

**Files:**
- Create: `src/app/__tests__/theme-mappings.test.ts`
- Read: `src/app/globals.css`

**Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(
  fileURLToPath(new URL("../globals.css", import.meta.url)),
  "utf8",
);

describe("light theme color mappings", () => {
  it("gives Emerald topic pills a readable light-theme surface and foreground", () => {
    expect(globalsCss).toMatch(
      /html\[data-theme="light"\] \.bg-emerald-500\\\/10\s*\{[^}]*background-color:\s*rgba\(16, 185, 129, 0\.12\);[^}]*\}/s,
    );
    expect(globalsCss).toMatch(
      /html\[data-theme="light"\] \.text-emerald-200\\\/90,?[^}]*\{[^}]*color:\s*#047857;[^}]*\}/s,
    );
  });
});
```

**Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- src/app/__tests__/theme-mappings.test.ts`

Expected: FAIL because `globals.css` has no light-theme selectors for either utility.

### Task 2: Add the global Emerald mappings

**Files:**
- Modify: `src/app/globals.css:109-113`
- Modify: `src/app/globals.css:205-207`

**Step 1: Add the minimal background mapping**

```css
html[data-theme="light"] .bg-emerald-500\/10 {
  background-color: rgba(16, 185, 129, 0.12);
}
```

**Step 2: Extend the existing Emerald foreground mapping**

```css
html[data-theme="light"] .text-emerald-200\/90,
html[data-theme="light"] .text-emerald-300 {
  color: #047857;
}
```

**Step 3: Run the focused test to verify it passes**

Run: `pnpm test -- src/app/__tests__/theme-mappings.test.ts`

Expected: PASS with one passing test.

### Task 3: Verify the complete change

**Files:**
- Verify: `src/app/globals.css`
- Verify: `src/app/[locale]/u/[username]/page.tsx`

**Step 1: Run automated verification**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: all commands exit successfully with no test, type, or lint failures.

**Step 2: Start the local app and inspect Light**

Open a profile with populated domain topics, choose Light in the navbar, and confirm the topic foreground and pale Emerald surface are clearly distinguishable from the card background.

**Step 3: Inspect Dark**

Choose Dark and confirm the existing dark Emerald topic pill appearance is unchanged. Inspect card borders, language bars, nearby text, and navigation controls.

**Step 4: Inspect Auto**

Choose Auto and confirm the resolved theme matches the system preference and renders the same correct topic treatment as its corresponding explicit theme.

**Step 5: Review the final diff**

Run: `git diff -- src/app/globals.css src/app/__tests__/theme-mappings.test.ts`

Expected: only the new test and the two scoped light-theme mappings appear.
