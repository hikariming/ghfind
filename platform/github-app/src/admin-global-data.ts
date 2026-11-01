import { ApiError, positive, type github } from "./github";
import { ADMIN_PAGE_SIZE, loadAdminData, parseAdminFilters, type AdminData } from "./admin-data";
import { compareJobsByItem } from "./job-display-order";

export const GLOBAL_ACCOUNT_PAGE_SIZE = 4;
export interface GlobalRepositoryScope {
  /** At most one 25-repository display page from the authenticated user endpoint. */
  repositories: ReadonlyMap<number, string>;
  totalAccessible: number;
  hasNext: boolean;
  partial?: boolean;
}
export interface AdminGlobalData extends AdminData {
  globalScope: {
    installationPage: number;
    installationPageSize: number;
    totalInstallations: number;
    checkedInstallations: number;
    hasPrevious: boolean;
    hasNext: boolean;
    partial: boolean;
  };
  accounts: {
    id: number; account: string; accessible: number; checked: number; writable: number;
    admin: number; processing: number; paused: number; triage: number;
    failed: number; pending: number; running: number; partial: boolean;
  }[];
}

/** Aggregate only current authenticated installation memberships and live write
 * permission. Work is explicitly bounded/paginated; incomplete scope is never
 * presented as an all-account total. Historical owner/install guards remain in
 * loadAdminData. No credential, permission or request state is cached globally.
 */
export async function loadGlobalAdminData(
  env: Env,
  api: ReturnType<typeof github>,
  installations: readonly { id: number; account: string }[],
  repositoryScope: (installation: number, repoPage: number) => Promise<GlobalRepositoryScope>,
  params: URLSearchParams,
  now = Date.now(),
): Promise<AdminGlobalData> {
  const { repoPage } = parseAdminFilters(params);
  const pages = params.getAll("account_page");
  if (pages.length > 1 || (pages[0] !== undefined && !/^[1-9]\d{0,2}$/.test(pages[0])))
    throw new Error("Invalid account page");
  const accountPage = pages[0] === undefined ? 1 : Number(pages[0]);
  if (accountPage > Math.max(1, Math.ceil(installations.length / GLOBAL_ACCOUNT_PAGE_SIZE)) || accountPage > 250 || !Number.isSafeInteger(now) || now < 30 * 86400_000)
    throw new Error("Invalid dashboard context");
  const ids = new Set<number>();
  for (const installation of installations) {
    positive(installation.id);
    if (ids.has(installation.id)) throw new Error("Duplicate installation");
    ids.add(installation.id);
  }
  const selected = installations.slice((accountPage - 1) * GLOBAL_ACCOUNT_PAGE_SIZE, accountPage * GLOBAL_ACCOUNT_PAGE_SIZE);
  const scopes: { installation: typeof selected[number]; scope: GlobalRepositoryScope }[] = [];
  const memberships = new Map<number, number>();
  const ambiguous = new Set<number>();
  // Sequential account batches keep existing six-query D1 fanout bounded.
  for (const installation of selected) {
    let scope: GlobalRepositoryScope;
    try { scope = await repositoryScope(installation.id, repoPage); }
    catch (error) {
      // An installation can disappear between the membership and repo reads.
      // Fail closed without hiding the fact that global coverage is incomplete.
      if (!(error instanceof ApiError) || ![403,404].includes(error.status) || error.retry) throw error;
      scope = { repositories: new Map(), totalAccessible: 0, hasNext: false, partial: true };
    }
    if (scope.repositories.size > ADMIN_PAGE_SIZE || !Number.isSafeInteger(scope.totalAccessible) || scope.totalAccessible < scope.repositories.size)
      throw new Error("Invalid global repository scope");
    for (const id of scope.repositories.keys()) {
      positive(id);
      if (memberships.has(id)) ambiguous.add(id);
      memberships.set(id, installation.id);
    }
    scopes.push({ installation, scope });
  }
  const out: AdminGlobalData = {
    scope: { page: repoPage, pageSize: ADMIN_PAGE_SIZE, totalAccessible: 0, checked: 0, authorized: 0,
      partial: false, hasNext: false, hasPrevious: repoPage > 1 },
    repositories: [],
    overview: { since: now - 30 * 86400_000, until: now,
      jobStates: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
      totalJobs: 0, duePending: 0, leasedRunning: 0, staleRunning: 0,
      cleanupStates: { planning: 0, planned: 0, running: 0, done: 0, failed: 0, cancelled: 0, expired: 0 }, totalCleanups: 0 },
    tasks: { rows: [], page: 1, pageSize: ADMIN_PAGE_SIZE, hasNext: false, hasPrevious: false, truncated: false, filters: { q: "" } },
    activity: { rows: [], page: 1, pageSize: ADMIN_PAGE_SIZE, hasNext: false, hasPrevious: false, truncated: false },
    cleanups: [], cleanupsHasMore: false,
    globalScope: { installationPage: accountPage, installationPageSize: GLOBAL_ACCOUNT_PAGE_SIZE,
      totalInstallations: installations.length, checkedInstallations: selected.length,
      hasPrevious: accountPage > 1, hasNext: accountPage * GLOBAL_ACCOUNT_PAGE_SIZE < installations.length,
      partial: selected.length < installations.length || ambiguous.size > 0 },
    accounts: [],
  };
  for (const { installation, scope } of scopes) {
    const unambiguous = new Map([...scope.repositories].filter(([id]) => !ambiguous.has(id)));
    const data = await loadAdminData(env, api, installation.id, unambiguous, new URLSearchParams(), now);
    const partial = !!scope.partial || ambiguous.size > 0 || scope.totalAccessible > data.scope.checked;
    out.scope.totalAccessible += scope.totalAccessible;
    out.scope.checked += data.scope.checked;
    out.scope.authorized += data.scope.authorized;
    out.scope.hasNext ||= scope.hasNext;
    out.scope.partial ||= partial;
    out.globalScope.partial ||= partial;
    for (const state of Object.keys(data.overview.jobStates) as (keyof AdminData["overview"]["jobStates"])[])
      out.overview.jobStates[state] += data.overview.jobStates[state];
    for (const state of Object.keys(data.overview.cleanupStates) as (keyof AdminData["overview"]["cleanupStates"])[])
      out.overview.cleanupStates[state] += data.overview.cleanupStates[state];
    for (const key of ["totalJobs","duePending","leasedRunning","staleRunning","totalCleanups"] as const)
      out.overview[key] += data.overview[key];
    out.repositories.push(...data.repositories.map(row => ({ ...row, installation: installation.id, account: installation.account })));
    out.tasks.rows.push(...data.tasks.rows);
    out.tasks.hasNext ||= data.tasks.hasNext;
    out.activity.rows.push(...data.activity.rows.map(row => ({ ...row, installation: installation.id })));
    out.activity.hasNext ||= data.activity.hasNext;
    out.cleanups.push(...data.cleanups.map(row => ({ ...row, installation: installation.id })));
    out.cleanupsHasMore ||= data.cleanupsHasMore;
    out.accounts.push({ id: installation.id, account: installation.account,
      accessible: scope.totalAccessible, checked: data.scope.checked, writable: data.scope.authorized,
      admin: data.repositories.filter(row => row.admin).length,
      processing: data.repositories.filter(row => row.settings.issuesEnabled || row.settings.prsEnabled).length,
      paused: data.repositories.filter(row => !row.settings.issuesEnabled && !row.settings.prsEnabled).length,
      triage: data.repositories.filter(row => row.settings.triageEnabled).length,
      failed: data.overview.jobStates.failed, pending: data.overview.jobStates.pending, running: data.overview.jobStates.running, partial });
  }
  out.tasks.rows.sort(compareJobsByItem);
  out.activity.rows.sort((a,b) => b.created - a.created || b.id - a.id);
  return out;
}
