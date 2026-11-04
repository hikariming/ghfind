# Profile Reactions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add durable GitHub-authenticated reactions with counts, switching/removal, and a responsive animated reaction bar on profile pages.

**Architecture:** A small domain module owns the fixed reaction set and response types. The existing libSQL layer stores one row per `(target, GitHub voter)` and returns authoritative aggregate state. A protected route exposes mutations, while the server-rendered profile page supplies initial state to a client reaction bar.

**Tech Stack:** Next.js 16 App Router, React 19, Auth.js v5, Turso/libSQL, next-intl, Tailwind CSS, Vitest.

---

### Task 1: Define reaction domain behavior

**Files:**
- Create: `src/lib/reactions.ts`
- Create: `src/lib/__tests__/reactions.test.ts`

**Steps:**
1. Write failing tests for the six-value allowlist, count initialization, and selected-count replacement behavior.
2. Run `pnpm test src/lib/__tests__/reactions.test.ts` and confirm failure because the module is missing.
3. Implement the minimal typed constants, validators, and helpers.
4. Re-run the focused test and confirm it passes.

### Task 2: Persist one durable reaction per GitHub user and profile

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/lib/__tests__/db.test.ts`

**Steps:**
1. Write failing database tests for selecting, switching, deleting, aggregate counts, and target username normalization.
2. Run the focused database test and confirm the new API is missing.
3. Add the `profile_reactions` schema and minimal read/upsert/delete functions.
4. Re-run database and reaction tests.

### Task 3: Add authenticated reaction API

**Files:**
- Create: `src/app/api/profile-reactions/[username]/route.ts`

**Steps:**
1. Implement `PUT` and `DELETE` around Auth.js session identity and the tested database functions.
2. Return `401` for logged-out requests, `400` for invalid input, and `503` for unavailable persistence.
3. Run typecheck to verify route contracts.

### Task 4: Add the reaction bar

**Files:**
- Create: `src/components/ProfileReactions.tsx`
- Modify: `src/app/[locale]/u/[username]/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/messages/zh.json`
- Modify: `src/messages/en.json`
- Modify: `src/messages/__tests__/messages.test.ts`

**Steps:**
1. Add matching bilingual message keys and update message parity coverage.
2. Render initial counts/viewer state from the server page.
3. Implement responsive buttons, selected/disabled/error states, sign-in prompt, and mutation handling.
4. Add short count/button animation with reduced-motion fallback.
5. Run focused tests, lint, and typecheck.

### Task 5: Verify the complete feature

**Files:**
- Review all changed files.

**Steps:**
1. Run `pnpm test`.
2. Run `pnpm lint`.
3. Run `pnpm typecheck`.
4. Run `pnpm build`.
5. Start the app and visually verify the profile reaction bar at desktop and mobile widths.
6. Review `git diff` against the approved design and report any remaining limitations.
