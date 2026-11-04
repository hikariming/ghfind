# Project Discovery & Retention Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the existing developer and repository graph into a searchable `/projects` discovery flow with contextual next steps and local “continue exploring,” while keeping Roast as the primary entry point.

**Architecture:** Keep `/developers/repo/{owner}/{name}` as the canonical project detail route and add `/projects` as the discovery surface. Extend the existing Turso data layer and Redis cache-aside helpers, expose one backward-compatible search API, and reuse shared client components in the navbar, mobile menu, and homepage Omnibox. Recommendations stay deterministic and use repository metadata, contributor scores, shared contributors, recent lookup heat, and local browser history.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, next-intl, Turso/libSQL, Upstash Redis, Tailwind CSS, Vitest.

---

## Working-tree constraint

Phase A/B already exists as uncommitted work in `src/lib/db.ts`, `src/lib/repo-graph.ts`, the repo backfill route, the repo overview components, the project bucket page, and the profile page. Preserve those changes. Do not reset or overwrite unrelated work. Commit only files that belong to the task being completed.

### Task 1: Establish the Phase A/B baseline

**Files:**
- Test: `src/lib/__tests__/repo-graph.test.ts`
- Test: `src/lib/__tests__/db.test.ts`
- Verify: `src/app/api/admin/backfill-repos/route.ts`
- Verify: `src/app/[locale]/developers/[type]/[...value]/page.tsx`
- Verify: `src/app/[locale]/u/[username]/page.tsx`

**Step 1: Run the focused repo-graph tests**

Run: `pnpm vitest run src/lib/__tests__/repo-graph.test.ts src/lib/__tests__/db.test.ts`

Expected: all existing repo graph, upsert, overview, and filtering tests pass.

**Step 2: Run type checking before new work**

Run: `pnpm typecheck`

Expected: exit 0.

**Step 3: Record the baseline diff**

Run: `git diff --stat && git status --short`

Expected: only the known Phase A/B work and unrelated user files are present.

**Step 4: Commit the Phase A/B implementation as its own unit**

Stage only the repo graph, backfill, overview, profile-link, translations, tracking, and related tests. Do not stage `.codex-audit/`, unrelated plans, or ingestion scripts.

Run: `git commit -m "feat(projects): add repository graph and profile links"`

### Task 2: Add project ranking and recommendation primitives

**Files:**
- Create: `src/lib/projects.ts`
- Create: `src/lib/__tests__/projects.test.ts`

**Step 1: Write failing tests for quality and recommendation reasons**

Cover:

```ts
expect(projectQualityScore(90, 3)).toBeCloseTo(180);
expect(projectQualityScore(90, 0)).toBe(0);
expect(projectRecommendationReason({ eliteCount: 3, momentum: 2, avgScore: 85 })).toBe("elite");
expect(projectRecommendationReason({ eliteCount: 0, momentum: 20, avgScore: 70 })).toBe("momentum");
expect(projectRecommendationReason({ eliteCount: 0, momentum: 1, avgScore: 90 })).toBe("quality");
```

Also test stable sort parsing for `quality`, `momentum`, and `stars`, invalid-sort fallback, page parsing, and language normalization.

**Step 2: Run the tests and verify RED**

Run: `pnpm vitest run src/lib/__tests__/projects.test.ts`

Expected: FAIL because `src/lib/projects.ts` does not exist.

**Step 3: Implement the pure primitives**

Implement:

```ts
export type ProjectSort = "quality" | "momentum" | "stars";
export type ProjectReason = "elite" | "momentum" | "quality" | "popular";

export function projectQualityScore(avgScore: number, contributorCount: number) {
  if (contributorCount <= 0) return 0;
  return avgScore * Math.log2(contributorCount + 1);
}
```

Add deterministic reason selection and URL parameter parsers. Keep localization out of this module; return reason tokens.

**Step 4: Run the tests and verify GREEN**

Run: `pnpm vitest run src/lib/__tests__/projects.test.ts`

Expected: PASS.

**Step 5: Commit**

Run: `git add src/lib/projects.ts src/lib/__tests__/projects.test.ts && git commit -m "feat(projects): add ranking primitives"`

### Task 3: Add project-list, search, related-project, and common-project queries

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/lib/__tests__/db.test.ts`

**Step 1: Write failing integration tests**

Seed a local libSQL database with:

- four repos across TypeScript and Rust;
- owners and contributors in multiple tiers;
- hidden and low-score accounts;
- recent and stale lookup rows;
- overlapping contributors.

Add tests for:

- `getProjects({sort:"quality"})` ordering by average score × log contributor count;
- `getProjects({sort:"momentum"})` using recent lookup activity;
- `getProjects({sort:"stars"})` ordering by stars;
- language filtering and stable pagination;
- hidden accounts excluded from aggregates;
- `searchRepos()` matching `owner/name` and bare project names;
- `getRelatedProjects()` preferring shared contributors, then same language/topics;
- `getDeveloperCommonProjects()` returning repo intersections;
- all functions returning safe empty values when the DB is absent.

**Step 2: Run the DB tests and verify RED**

Run: `pnpm vitest run src/lib/__tests__/db.test.ts`

Expected: FAIL because the query functions and types are missing.

**Step 3: Implement query types and functions**

Add:

```ts
export interface ProjectListItem {
  repo: RepoDetail;
  contributorCount: number;
  avgScore: number;
  eliteCount: number;
  momentum: number;
  qualityScore: number;
  topContributors: RepoOwnerRef[];
}
```

Use CTEs to aggregate scored, non-hidden contributors once per query. Clamp `limit` and `offset`. Use a seven-day cutoff for momentum. Parse Topics through the existing JSON helper. Return empty arrays instead of throwing.

**Step 4: Run the DB tests and verify GREEN**

Run: `pnpm vitest run src/lib/__tests__/db.test.ts`

Expected: PASS.

**Step 5: Run repo graph regression tests**

Run: `pnpm vitest run src/lib/__tests__/repo-graph.test.ts src/lib/__tests__/db.test.ts`

Expected: PASS.

**Step 6: Commit**

Run: `git add src/lib/db.ts src/lib/__tests__/db.test.ts && git commit -m "feat(projects): query project discovery graph"`

### Task 4: Add cached project data services

**Files:**
- Create: `src/lib/project-discovery.ts`
- Create: `src/lib/__tests__/project-discovery.test.ts`
- Reference: `src/lib/developers.ts`
- Reference: `src/lib/redis.ts`

**Step 1: Write failing tests for cache keys and fallback**

Test deterministic cache keys for sort, page, language, related repo, and common developers. Inject a failing cache adapter and assert the DB loader still returns data.

**Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/lib/__tests__/project-discovery.test.ts`

Expected: FAIL because the module is missing.

**Step 3: Implement cache-aside wrappers**

Mirror `src/lib/developers.ts`:

- project list TTL: 600 seconds;
- related projects TTL: 600 seconds;
- search TTL: 300 seconds;
- in-process single-flight per cache key;
- DB fallback when Redis is unavailable.

**Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run src/lib/__tests__/project-discovery.test.ts`

Expected: PASS.

**Step 5: Commit**

Run: `git add src/lib/project-discovery.ts src/lib/__tests__/project-discovery.test.ts && git commit -m "feat(projects): cache discovery queries"`

### Task 5: Extend search without breaking the homepage Omnibox

**Files:**
- Create: `src/lib/search.ts`
- Create: `src/lib/__tests__/search.test.ts`
- Modify: `src/app/api/search-users/route.ts`
- Modify: `src/components/Omnibox.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/zh.json`

**Step 1: Write failing tests for response shaping**

Test that the search result shape always includes:

```ts
{ users: [], repos: [], facets: [] }
```

Test that the legacy `users` field is unchanged, repo results include canonical internal hrefs, and facet results distinguish language and organization.

**Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/lib/__tests__/search.test.ts`

Expected: FAIL because the search composition module is missing.

**Step 3: Implement shared search composition**

Add `searchDiscovery(query)` that runs scored-user, repo, and constrained facet searches in parallel. Require one non-space character, cap each group, and return safe empty groups on failure.

**Step 4: Extend the API**

Keep the existing route and cache headers. Return all three groups. Do not rename the endpoint during this task.

**Step 5: Merge repo results into the homepage Omnibox**

Preserve Roast and PK intent behavior. Add project rows under the existing Discover group; selecting one navigates to `/developers/repo/{owner}/{name}`. Do not make project results replace a direct username action.

**Step 6: Run tests and verify GREEN**

Run: `pnpm vitest run src/lib/__tests__/search.test.ts src/lib/__tests__/omnibox.test.ts`

Expected: PASS.

**Step 7: Commit**

Run: `git add src/lib/search.ts src/lib/__tests__/search.test.ts src/app/api/search-users/route.ts src/components/Omnibox.tsx src/messages/en.json src/messages/zh.json && git commit -m "feat(search): find developers projects and facets"`

### Task 6: Build the reusable global search UI and grouped navigation

**Files:**
- Create: `src/components/GlobalSearch.tsx`
- Create: `src/components/__tests__/globalSearch.test.tsx`
- Modify: `src/config/nav.ts`
- Modify: `src/components/NavLinks.tsx`
- Modify: `src/components/Navbar.tsx`
- Modify: `src/components/MobileMenu.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/zh.json`

**Step 1: Write failing navigation config tests**

Assert that Roast remains the first top-level item and Discover contains Developers, Projects, Languages, and Organizations. Assert every child has a stable href.

**Step 2: Write failing global-search interaction tests**

Cover opening, debounce, grouped rendering, ArrowDown/ArrowUp, Enter, Escape, empty results, and accessible dialog/searchbox names.

**Step 3: Run tests and verify RED**

Run: `pnpm vitest run src/components/__tests__/globalSearch.test.tsx src/components/__tests__/navConfig.test.ts`

Expected: FAIL because the component and grouped config do not exist.

**Step 4: Implement grouped navigation**

Use the existing `children` support in `NavLinks`. Add `/projects` and constrained discover URLs such as `/developers#languages` and `/developers#organizations`. Keep active-state behavior correct for project detail routes and `/projects`.

**Step 5: Implement `GlobalSearch`**

Use a button-triggered dialog on desktop and an inline trigger at the top of the mobile sheet. Share the same result rendering and keyboard state. Use semantic headings, listbox/option roles where appropriate, and visible focus styles.

**Step 6: Run tests and verify GREEN**

Run: `pnpm vitest run src/components/__tests__/globalSearch.test.tsx src/components/__tests__/navConfig.test.ts`

Expected: PASS.

**Step 7: Commit**

Run: `git add src/components/GlobalSearch.tsx src/components/__tests__/globalSearch.test.tsx src/components/__tests__/navConfig.test.ts src/config/nav.ts src/components/NavLinks.tsx src/components/Navbar.tsx src/components/MobileMenu.tsx src/messages/en.json src/messages/zh.json && git commit -m "feat(nav): add grouped discovery and global search"`

### Task 7: Build `/projects` as a project-card content flow

**Files:**
- Create: `src/app/[locale]/projects/page.tsx`
- Create: `src/components/ProjectCard.tsx`
- Create: `src/components/ProjectControls.tsx`
- Create: `src/components/__tests__/projectCard.test.tsx`
- Modify: `src/app/sitemap.ts`
- Modify: `src/messages/en.json`
- Modify: `src/messages/zh.json`
- Modify: `src/lib/track.ts`

**Step 1: Write failing project-card tests**

Test description, stars, language, topics, contributor summary, top contributor links, reason token, canonical project href, and graceful omission of missing optional data.

**Step 2: Write failing control/parser tests**

Test quality/momentum/stars URLs, language filter, previous/next pagination, and preserving filters while changing sort.

**Step 3: Run tests and verify RED**

Run: `pnpm vitest run src/components/__tests__/projectCard.test.tsx src/lib/__tests__/projects.test.ts`

Expected: FAIL because the components are missing.

**Step 4: Implement the page and cards**

Use server-rendered initial data. Add metadata and locale alternates for `/projects`. Show an explicit empty state when `repos` has no rows. Keep cards compact enough to scan and include one clear primary link.

**Step 5: Add analytics events**

Add `project_card_click`, `project_sort_change`, and `project_filter_change` to the typed event union and fire them from client controls/cards.

**Step 6: Add sitemap entries**

Add localized `/projects` entries and continue using the existing project detail bucket URLs.

**Step 7: Run tests and verify GREEN**

Run: `pnpm vitest run src/components/__tests__/projectCard.test.tsx src/lib/__tests__/projects.test.ts src/messages/__tests__/messages.test.ts`

Expected: PASS.

**Step 8: Commit**

Run: `git add src/app/[locale]/projects/page.tsx src/components/ProjectCard.tsx src/components/ProjectControls.tsx src/components/__tests__/projectCard.test.tsx src/app/sitemap.ts src/messages/en.json src/messages/zh.json src/lib/track.ts && git commit -m "feat(projects): add project discovery feed"`

### Task 8: Add contextual next steps to project, profile, and leaderboard pages

**Files:**
- Create: `src/components/ProjectRecommendations.tsx`
- Create: `src/components/CommonProjects.tsx`
- Create: `src/components/DiscoveryNextSteps.tsx`
- Create: `src/components/__tests__/discoveryNextSteps.test.tsx`
- Modify: `src/app/[locale]/developers/[type]/[...value]/page.tsx`
- Modify: `src/app/[locale]/u/[username]/page.tsx`
- Modify: `src/app/[locale]/leaderboard/page.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/zh.json`
- Modify: `src/lib/track.ts`

**Step 1: Write failing rendering tests**

Test:

- related and same-language projects on a repo page;
- contributor links on a repo page;
- common-project cards on a profile page;
- project and organization discovery CTAs on the leaderboard;
- all sections hiding cleanly when empty.

**Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/components/__tests__/discoveryNextSteps.test.tsx`

Expected: FAIL because the recommendation components are missing.

**Step 3: Implement project-page next steps**

Fetch cached related projects next to the overview query. Render recommendations after the first contributor page so the user encounters a next step before pagination fatigue.

**Step 4: Implement profile-page next steps**

Place similar developers immediately after Featured Work. Add common project links using the current profile and each of the top similar developers; cap the section to avoid multiplying DB work.

**Step 5: Implement leaderboard CTAs**

Add compact project and organization discovery cards after the board, before footer/API promotion.

**Step 6: Add recommendation click tracking**

Add one typed event with `surface`, `kind`, and subject props.

**Step 7: Run tests and verify GREEN**

Run: `pnpm vitest run src/components/__tests__/discoveryNextSteps.test.tsx src/lib/__tests__/db.test.ts`

Expected: PASS.

**Step 8: Commit**

Run: `git add src/components/ProjectRecommendations.tsx src/components/CommonProjects.tsx src/components/DiscoveryNextSteps.tsx src/components/__tests__/discoveryNextSteps.test.tsx src/app/[locale]/developers/[type]/[...value]/page.tsx src/app/[locale]/u/[username]/page.tsx src/app/[locale]/leaderboard/page.tsx src/messages/en.json src/messages/zh.json src/lib/track.ts && git commit -m "feat(discovery): add contextual next steps"`

### Task 9: Add local “continue exploring” history

**Files:**
- Create: `src/lib/exploration-history.ts`
- Create: `src/lib/__tests__/exploration-history.test.ts`
- Create: `src/components/ExplorationBeacon.tsx`
- Create: `src/components/ContinueExploring.tsx`
- Create: `src/components/__tests__/continueExploring.test.tsx`
- Modify: `src/app/[locale]/page.tsx`
- Modify: `src/app/[locale]/u/[username]/page.tsx`
- Modify: `src/app/[locale]/developers/[type]/[...value]/page.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/zh.json`
- Modify: `src/lib/track.ts`

**Step 1: Write failing storage tests**

Test deduplication, most-recent-first order, 12-item cap, malformed JSON recovery, no search-query field, and unavailable-storage fallback.

**Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/lib/__tests__/exploration-history.test.ts`

Expected: FAIL because the module is missing.

**Step 3: Implement storage helpers**

Store only:

```ts
type ExplorationItem = {
  kind: "developer" | "project";
  key: string;
  title: string;
  subtitle?: string;
  href: string;
  visitedAt: number;
};
```

Use one versioned localStorage key and defensive parsing.

**Step 4: Write failing component tests**

Test hidden empty state, mixed project/developer cards, current-page exclusion, and click tracking.

**Step 5: Implement beacons and homepage module**

Record successful project and profile views after mount. Render `ContinueExploring` after `HomeFollowing` and before the leaderboard preview. Keep the static homepage shell intact.

**Step 6: Run tests and verify GREEN**

Run: `pnpm vitest run src/lib/__tests__/exploration-history.test.ts src/components/__tests__/continueExploring.test.tsx`

Expected: PASS.

**Step 7: Commit**

Run: `git add src/lib/exploration-history.ts src/lib/__tests__/exploration-history.test.ts src/components/ExplorationBeacon.tsx src/components/ContinueExploring.tsx src/components/__tests__/continueExploring.test.tsx src/app/[locale]/page.tsx src/app/[locale]/u/[username]/page.tsx src/app/[locale]/developers/[type]/[...value]/page.tsx src/messages/en.json src/messages/zh.json src/lib/track.ts && git commit -m "feat(home): continue recent exploration"`

### Task 10: Make the developer directory scannable and link it to Projects

**Files:**
- Modify: `src/app/[locale]/developers/page.tsx`
- Create: `src/components/__tests__/developerDirectory.test.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/zh.json`

**Step 1: Write failing directory tests**

Assert that the first view limits language and organization pills, exposes expand links/controls, has stable `#languages` and `#organizations` anchors, and sends the project section to `/projects` instead of dumping 48 project pills.

**Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/components/__tests__/developerDirectory.test.tsx`

Expected: FAIL against the current tag wall.

**Step 3: Implement the reduced directory**

Show a curated head for languages and organizations, with accessible “show more” behavior or dedicated expanded state. Replace the project tag wall with a preview of top project cards plus a prominent `/projects` CTA.

**Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run src/components/__tests__/developerDirectory.test.tsx`

Expected: PASS.

**Step 5: Commit**

Run: `git add src/app/[locale]/developers/page.tsx src/components/__tests__/developerDirectory.test.tsx src/messages/en.json src/messages/zh.json && git commit -m "feat(discovery): simplify developer directory"`

### Task 11: Verify backfill against an isolated local database

**Files:**
- Create: `scripts/prepare-local-project-discovery.mts`
- Create: `scripts/__tests__/prepare-local-project-discovery.test.ts`
- Modify: `README.md` or `docs/plans/2026-07-09-discovery-projects-design.md` with local/production commands

**Step 1: Write a failing script-level test**

Test that the script refuses non-`file:` destinations unless `--allow-remote` is explicitly passed, copies only the requested public snapshot sample, and prints row counts without credentials.

**Step 2: Run tests and verify RED**

Run: `pnpm vitest run scripts/__tests__/prepare-local-project-discovery.test.ts`

Expected: FAIL because the script is missing.

**Step 3: Implement the safe local preparation script**

The script must:

- require an explicit `file:` output path;
- read the configured source DB without printing URL/token;
- copy a bounded representative snapshot sample;
- create required score/facet rows;
- invoke the same repo graph extraction/write functions as production;
- print processed/repo/link counts;
- never mutate the source DB.

**Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run scripts/__tests__/prepare-local-project-discovery.test.ts`

Expected: PASS.

**Step 5: Create and inspect the local validation database**

Run: `pnpm tsx scripts/prepare-local-project-discovery.mts --output file:/tmp/ghfind-project-discovery.db --limit 200`

Expected: non-zero snapshot, repo, and repo-developer counts.

**Step 6: Run the app against the isolated DB**

Run: `TURSO_DATABASE_URL=file:/tmp/ghfind-project-discovery.db TURSO_AUTH_TOKEN= pnpm dev`

Expected: the app starts without accessing the production DB.

**Step 7: Commit**

Run: `git add scripts/prepare-local-project-discovery.mts scripts/__tests__/prepare-local-project-discovery.test.ts README.md docs/plans/2026-07-09-discovery-projects-design.md && git commit -m "test(projects): add isolated backfill validation"`

### Task 12: Full verification and visual QA

**Files:**
- Verify all files changed above
- Save screenshots under `.codex-audit/project-discovery-2026-07-11/`

**Step 1: Run the complete automated suite**

Run: `pnpm test`

Expected: 0 failed tests.

**Step 2: Run static checks**

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm lint`

Expected: exit 0 with no new warnings.

**Step 3: Run the production build**

Run: `pnpm build`

Expected: exit 0 and routes include localized `/projects`.

**Step 4: Perform browser QA with the isolated DB**

Inspect:

- homepage: Roast remains primary; following and continue-exploring order;
- global search: users, projects, facets, keyboard operation;
- `/projects`: all sorts, language filter, pagination, empty/missing fields;
- project detail: overview, contributor list, related projects, same-language projects;
- profile: internal repo links, common projects, similar developers position;
- leaderboard: project and organization next steps;
- mobile nav and mobile search.

Check Light, Dark, and Auto resolved themes. Check card borders, muted text, hover/focus states, dialogs, footer, mobile sheet, and background seams.

**Step 5: Capture accepted screenshots**

Save and inspect desktop dark, desktop light, mobile menu/search, `/projects`, project detail, and profile screenshots. Reject blank/loading/error captures.

**Step 6: Inspect the final diff**

Run: `git status --short && git diff --check && git log --oneline -12`

Expected: no accidental secrets, local DB files, or unrelated user changes staged.

**Step 7: Request code review**

Use `superpowers:requesting-code-review` against the design and this plan. Resolve Critical and Important findings, then re-run Steps 1–3.

**Step 8: Final handoff**

Report exact test/build counts, local backfill counts, validated pages/themes, remaining production-only steps, and the production dry-run/backfill commands without executing them.

