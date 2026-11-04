# Home Username Links Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Route both home-page `@username` links to the localized ghfind user detail page instead of GitHub.

**Architecture:** Replace the two external anchors with the existing locale-aware `Link` from `@/i18n/navigation`. Preserve all current classes and layering so only navigation behavior changes.

**Tech Stack:** Next.js 16, React 19, next-intl navigation, TypeScript, Vitest

---

### Task 1: Add a home username-link regression test

**Files:**
- Create: `src/components/__tests__/homeUsernameLinks.test.ts`
- Inspect: `src/components/Roaster.tsx`
- Inspect: `src/components/LeaderboardClient.tsx`

**Step 1: Write the failing test**

Read the two component sources and assert that the score result username and leaderboard username use locale-aware internal `/u/{username}` links, with no username-specific GitHub/profile URL override remaining.

**Step 2: Run test to verify it fails**

Run: `pnpm test src/components/__tests__/homeUsernameLinks.test.ts`

Expected: FAIL because both username controls still use external anchors.

### Task 2: Route both username controls internally

**Files:**
- Modify: `src/components/Roaster.tsx`
- Modify: `src/components/LeaderboardClient.tsx`
- Test: `src/components/__tests__/homeUsernameLinks.test.ts`

**Step 1: Write minimal implementation**

- Import `Link` from `@/i18n/navigation` in `Roaster.tsx`.
- Replace the score card username `<a>` with `<Link href={`/u/${scan.metrics.username}`}>` and remove external-tab attributes.
- Replace the leaderboard username `<a>` with `<Link href={`/u/${e.username}`} prefetch={false}>` and remove the now-unused `profileUrl` value.
- Keep existing classes unchanged.

**Step 2: Run test to verify it passes**

Run: `pnpm test src/components/__tests__/homeUsernameLinks.test.ts`

Expected: PASS.

**Step 3: Run project verification**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Expected: all commands exit successfully.

**Step 4: Verify themes and navigation manually**

Run the app and inspect the affected score card and home leaderboard under Light, Dark, and Auto. Confirm both usernames navigate to the localized user detail page and that card contrast, hover styles, borders, and mobile layout are unchanged.

**Step 5: Commit**

```bash
git add docs/archive/plans/2026-07-02-home-username-links.md \
  src/components/__tests__/homeUsernameLinks.test.ts \
  src/components/Roaster.tsx \
  src/components/LeaderboardClient.tsx
git commit -m "fix: route home usernames to profile pages"
```
