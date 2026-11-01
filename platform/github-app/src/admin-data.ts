import { ApiError, github, positive, record, repositoryName } from "./github";
import { getSettings, type RepoSettings } from "./settings";
import { JOINED_JOB_ITEM_ORDER_SQL } from "./job-display-order";

export const ADMIN_PAGE_SIZE = 25;
const MAX_PAGE = 400;
const WINDOW = 30 * 86400_000;
export const JOB_STATES = ["pending", "running", "done", "failed", "cancelled"] as const;
export const JOB_KINDS = ["discover", "initialize", "label"] as const;
export const CLEANUP_STATES = ["planning", "planned", "running", "done", "failed", "cancelled", "expired"] as const;
export type JobState = typeof JOB_STATES[number];
export type JobKind = typeof JOB_KINDS[number];
export type CleanupState = typeof CLEANUP_STATES[number];

export interface AdminRepository {
  installation?: number;
  account?: string;
  id: number;
  fullName: string;
  admin: boolean;
  settings: RepoSettings;
  lastActivity: number | null;
}
export interface AdminTask {
  id: string;
  installation: number;
  repository: number;
  full_name: string;
  fullName: string;
  pr: number | null;
  kind: JobKind;
  state: JobState;
  attempts: number;
  created: number;
  started: number;
  due: number;
  lease: number;
  page: number;
  result: string | null;
  updated: number;
  admin: boolean;
}
export interface AdminAudit {
  installation?: number;
  id: number;
  repository: number;
  fullName: string;
  actor: string;
  via: "web" | "api";
  action: string;
  detail: unknown;
  created: number;
  at: string;
}
export interface AdminCleanup {
  installation?: number;
  id: string;
  repository: number;
  full_name: string;
  fullName: string;
  state: CleanupState;
  expires: number;
  total: number;
  done: number;
  skipped: number;
  lease: number;
  attempts: number;
  result: string | null;
  created: number;
  updated: number;
  admin: boolean;
}
export interface AdminPage<T> {
  rows: T[];
  page: number;
  pageSize: number;
  hasNext: boolean;
  hasPrevious: boolean;
  truncated: boolean;
}
export interface AdminFilters {
  q: string;
  repository?: number;
  status?: JobState;
  kind?: JobKind;
}
export interface AdminData {
  scope: {
    page: number;
    pageSize: number;
    totalAccessible: number;
    checked: number;
    authorized: number;
    partial: boolean;
    hasNext: boolean;
    hasPrevious: boolean;
  };
  repositories: AdminRepository[];
  overview: {
    since: number;
    until: number;
    jobStates: Record<JobState, number>;
    totalJobs: number;
    duePending: number;
    leasedRunning: number;
    staleRunning: number;
    cleanupStates: Record<CleanupState, number>;
    totalCleanups: number;
  };
  tasks: AdminPage<AdminTask> & { filters: AdminFilters };
  activity: AdminPage<AdminAudit>;
  cleanups: AdminCleanup[];
  cleanupsHasMore: boolean;
}

function param(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  if (values.length > 1) throw new Error(`Invalid ${name}`);
  return values[0];
}
function integer(text: string | undefined, name: string, fallback: number, maximum: number) {
  if (text === undefined) return fallback;
  if (!/^[1-9]\d{0,15}$/.test(text)) throw new Error(`Invalid ${name}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n > maximum) throw new Error(`Invalid ${name}`);
  return n;
}
function choice<T extends string>(value: string | undefined, choices: readonly T[], name: string): T | undefined {
  if (value === undefined || value === "") return undefined;
  if (!choices.includes(value as T)) throw new Error(`Invalid ${name}`);
  return value as T;
}
export function parseAdminFilters(params: URLSearchParams) {
  const q = (param(params, "q") ?? "").trim();
  if (q.length > 100 || /[\x00-\x1f\x7f]/.test(q)) throw new Error("Invalid search");
  const repo = param(params, "repository");
  return {
    repoPage: integer(param(params, "repo_page"), "repo_page", 1, MAX_PAGE),
    taskPage: integer(param(params, "task_page"), "task_page", 1, MAX_PAGE),
    activityPage: integer(param(params, "activity_page"), "activity_page", 1, MAX_PAGE),
    filters: {
      q,
      repository: repo === undefined || repo === "" ? undefined : integer(repo, "repository", 1, Number.MAX_SAFE_INTEGER),
      status: choice(param(params, "status"), JOB_STATES, "status"),
      kind: choice(param(params, "kind"), JOB_KINDS, "kind"),
    } satisfies AdminFilters,
  };
}
function page<T>(rows: T[], current: number): AdminPage<T> {
  return { rows: rows.slice(0, ADMIN_PAGE_SIZE), page: current, pageSize: ADMIN_PAGE_SIZE,
    hasNext: current < MAX_PAGE && rows.length > ADMIN_PAGE_SIZE, hasPrevious: current > 1,
    truncated: current === MAX_PAGE && rows.length > ADMIN_PAGE_SIZE };
}
function parsed(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return {}; }
}
const owner = (name: string) => name.split("/")[0].toLowerCase();
// The map MUST come from the user-token installation repositories endpoint in
// this request. It establishes installation membership; each selected repo's
// live endpoint separately establishes write access. No auth cache is used.
export async function loadAdminData(
  env: Env,
  api: ReturnType<typeof github>,
  installation: number,
  accessibleRepos: ReadonlyMap<number, string>,
  params: URLSearchParams,
  now = Date.now(),
): Promise<AdminData> {
  positive(installation);
  if (!Number.isSafeInteger(now) || now < WINDOW) throw new Error("Invalid timestamp");
  const { repoPage, taskPage, activityPage, filters } = parseAdminFilters(params);
  const candidates = [...accessibleRepos].slice((repoPage - 1) * ADMIN_PAGE_SIZE, repoPage * ADMIN_PAGE_SIZE);
  const authorized: { id: number; fullName: string; admin: boolean }[] = [];
  // At most 25 permission calls per request, with five in flight. Failure to
  // establish permission never turns into a successful partial SQL response.
  for (let start = 0; start < candidates.length; start += 5) {
    const group = await Promise.all(candidates.slice(start, start + 5).map(async ([id, name]) => {
      positive(id);
      repositoryName(name);
      let repo: Record<string, unknown>;
      try { repo = record(await api(`/repos/${name}`)); }
      catch (error) {
        if (error instanceof ApiError && [403, 404].includes(error.status) && !error.retry) return null;
        throw error;
      }
      // GitHub can redirect a repository URL after a transfer/rename. Reject
      // a different id and take the current name from the live response.
      if (positive(repo.id) !== id) return null;
      const fullName = repositoryName(repo.full_name);
      // A transfer racing the installation listing invalidates that membership
      // evidence; the next request must discover the new installation scope.
      if (owner(fullName) !== owner(name)) return null;
      const perms = record(repo.permissions);
      if (perms.admin !== true && perms.push !== true) return null;
      return { id, fullName, admin: perms.admin === true };
    }));
    for (const repo of group) if (repo) authorized.push(repo);
  }
  const scope: AdminData["scope"] = {
    page: repoPage, pageSize: ADMIN_PAGE_SIZE, totalAccessible: accessibleRepos.size,
    checked: candidates.length, authorized: authorized.length,
    partial: accessibleRepos.size > candidates.length,
    hasNext: repoPage < MAX_PAGE && repoPage * ADMIN_PAGE_SIZE < accessibleRepos.size,
    hasPrevious: repoPage > 1,
  };
  const overview: AdminData["overview"] = {
    since: now - WINDOW, until: now,
    jobStates: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
    totalJobs: 0, duePending: 0, leasedRunning: 0, staleRunning: 0,
    cleanupStates: { planning: 0, planned: 0, running: 0, done: 0, failed: 0, cancelled: 0, expired: 0 }, totalCleanups: 0,
  };
  if (filters.repository !== undefined && !authorized.some((r) => r.id === filters.repository))
    throw new ApiError(404, false);
  if (!authorized.length) return { scope, repositories: [], overview,
    tasks: { ...page<AdminTask>([], taskPage), filters }, activity: page<AdminAudit>([], activityPage), cleanups: [], cleanupsHasMore: false };
  // Parameter-bound CTE keeps every query inside the same authorized scope.
  // Historical names are compared by owner: same-owner rename is preserved,
  // previous-owner job/cleanup text is hidden after a repository transfer.
  const cte = `WITH permitted(repository,fullName) AS (VALUES ${authorized.map(() => "(?,?)").join(",")})`;
  const bindings = authorized.flatMap((r) => [r.id, r.fullName]);
  const currentOwner = (alias: string) => `lower(substr(${alias}.full_name,1,instr(${alias}.full_name,'/')-1))=lower(substr(p.fullName,1,instr(p.fullName,'/')-1))`;
  const jobWhere = `j.installation=? AND ${currentOwner("j")}`;
  const cleanWhere = `c.installation=? AND ${currentOwner("c")}`;
  // audit_log is repository-scoped (no installation/name column). Hide it when
  // settings show a previous owner; do not pretend it is installation history.
  const auditWhere = `NOT EXISTS (SELECT 1 FROM repo_settings s WHERE s.repository=a.repository AND NOT (${currentOwner("s")}))`;
  const query = <T>(sql: string, extra: (string | number)[] = []) =>
    env.DB.prepare(`${cte} ${sql}`).bind(...bindings, ...extra).all<T>();
  const jobFilters = [jobWhere];
  const jobBinds: (string | number)[] = [installation];
  if (filters.repository !== undefined) { jobFilters.push("j.repository=?"); jobBinds.push(filters.repository); }
  if (filters.status) { jobFilters.push("j.state=?"); jobBinds.push(filters.status); }
  if (filters.kind) { jobFilters.push("j.kind=?"); jobBinds.push(filters.kind); }
  if (filters.q) {
    jobFilters.push("(instr(lower(j.id),lower(?))>0 OR instr(lower(p.fullName),lower(?))>0)");
    jobBinds.push(filters.q, filters.q);
  }
  const [jobStats, cleanupStats, jobs, audit, cleanup, last] = await Promise.all([
    query<{ state: JobState; count: number; due: number; leased: number; stale: number }>(
      `SELECT j.state,count(*) AS count,sum(CASE WHEN j.state='pending' AND j.due<=? THEN 1 ELSE 0 END) AS due,
       sum(CASE WHEN j.state='running' AND j.lease>? THEN 1 ELSE 0 END) AS leased,
       sum(CASE WHEN j.state='running' AND j.lease<=? THEN 1 ELSE 0 END) AS stale
       FROM jobs j JOIN permitted p ON p.repository=j.repository WHERE ${jobWhere} AND j.updated BETWEEN ? AND ? GROUP BY j.state`,
      [now, now, now, installation, overview.since, now]),
    query<{ state: CleanupState; count: number }>(
      `SELECT CASE WHEN c.state='planned' AND c.expires<=? THEN 'expired' ELSE c.state END AS state,count(*) AS count
       FROM cleanups c JOIN permitted p ON p.repository=c.repository WHERE ${cleanWhere} AND c.updated BETWEEN ? AND ? GROUP BY 1`,
      [now, installation, overview.since, now]),
    query<Omit<AdminTask, "admin">>(
      `SELECT j.id,j.installation,j.repository,j.full_name,p.fullName,j.pr,j.kind,j.state,j.attempts,j.created,j.started,j.due,j.lease,j.page,substr(j.result,1,2000) AS result,j.updated
       FROM jobs j JOIN permitted p ON p.repository=j.repository WHERE ${jobFilters.join(" AND ")}
       ORDER BY lower(p.fullName) ASC,j.repository ASC,${JOINED_JOB_ITEM_ORDER_SQL} LIMIT ? OFFSET ?`,
      [...jobBinds, ADMIN_PAGE_SIZE + 1, (taskPage - 1) * ADMIN_PAGE_SIZE]),
    query<Omit<AdminAudit, "at" | "detail"> & { detail: string }>(
      `SELECT a.id,a.repository,p.fullName,substr(a.actor,1,100) AS actor,a.via,substr(a.action,1,100) AS action,substr(a.detail,1,4000) AS detail,a.created
       FROM audit_log a JOIN permitted p ON p.repository=a.repository WHERE ${auditWhere}${filters.repository !== undefined ? " AND a.repository=?" : ""}
       ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      [...(filters.repository !== undefined ? [filters.repository] : []), ADMIN_PAGE_SIZE + 1, (activityPage - 1) * ADMIN_PAGE_SIZE]),
    query<Omit<AdminCleanup, "admin">>(
      `SELECT c.id,c.repository,c.full_name,p.fullName,CASE WHEN c.state='planned' AND c.expires<=? THEN 'expired' ELSE c.state END AS state,
       c.expires,c.total,c.done,c.skipped,c.lease,c.attempts,substr(c.result,1,2000) AS result,c.created,c.updated
       FROM cleanups c JOIN permitted p ON p.repository=c.repository WHERE ${cleanWhere}
       ORDER BY c.updated DESC,c.id DESC LIMIT ?`, [now, installation, ADMIN_PAGE_SIZE + 1]),
    query<{ repository: number; updated: number }>(
      `SELECT repository,max(updated) AS updated FROM (
       SELECT j.repository,j.updated FROM jobs j JOIN permitted p ON p.repository=j.repository WHERE ${jobWhere}
       UNION ALL SELECT c.repository,c.updated FROM cleanups c JOIN permitted p ON p.repository=c.repository WHERE ${cleanWhere}
       UNION ALL SELECT a.repository,a.created AS updated FROM audit_log a JOIN permitted p ON p.repository=a.repository WHERE ${auditWhere}
       UNION ALL SELECT s.repository,s.updated FROM repo_settings s JOIN permitted p ON p.repository=s.repository WHERE ${currentOwner("s")}
       ) GROUP BY repository`, [installation, installation]),
  ]);
  for (const s of jobStats.results) {
    overview.jobStates[s.state] = s.count;
    overview.totalJobs += s.count;
    overview.duePending += s.due;
    overview.leasedRunning += s.leased;
    overview.staleRunning += s.stale;
  }
  for (const s of cleanupStats.results) { overview.cleanupStates[s.state] = s.count; overview.totalCleanups += s.count; }
  const repositories = await Promise.all(authorized.map(async (r) => ({ ...r,
    settings: await getSettings(env, r.id, r.fullName),
    lastActivity: last.results.find((x) => x.repository === r.id)?.updated ?? null,
  })));
  const admins = new Set(authorized.filter((r) => r.admin).map((r) => r.id));
  return { scope, repositories, overview,
    tasks: { ...page(jobs.results.map((r) => ({ ...r, admin: admins.has(r.repository) })), taskPage), filters },
    activity: page(audit.results.map((r) => ({ ...r, detail: parsed(r.detail), at: new Date(r.created).toISOString() })), activityPage),
    cleanups: cleanup.results.slice(0, ADMIN_PAGE_SIZE).map((r) => ({ ...r, admin: admins.has(r.repository) })),
    cleanupsHasMore: cleanup.results.length > ADMIN_PAGE_SIZE,
  };
}
