/**
 * Garbage collection for the legacy Next Worker's OpenNext R2 incremental
 * cache. OpenNext keys every entry as `incremental-cache/<buildId>/<hash>.<type>`
 * and never deletes old builds, and each deploy re-uploads every prerendered
 * page (`populateCache`), so the bucket grows with every deploy — CI deploys
 * dev on each push and PR previews share the dev bucket.
 *
 * A build directory is deleted only when it is BOTH outside the newest
 * `keepNewest` builds (by most recent write) AND has had no write for
 * `minIdleMs`. Age-only lifecycle rules are unsafe here: pages rendered with
 * `dynamicParams = false` are written once at deploy and 404 when missing, so
 * a live-but-quiet build must never lose its entries.
 *
 * Retire this (and the buckets) together with the Next Worker (migration P5).
 */

export interface GcObject {
  key: string;
  uploaded: Date;
}

/** The slice of an R2Bucket binding this module uses. */
export interface GcBucket {
  list(options: {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: GcObject[]; delimitedPrefixes: string[]; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
  put(key: string, value: string): Promise<unknown>;
}

export interface GcOptions {
  /** OpenNext's cache root, with trailing slash. */
  root: string;
  keepNewest: number;
  minIdleMs: number;
  now: number;
  dryRun: boolean;
  /** Upper bound on R2 list/delete calls per run; unfinished work resumes next run. */
  maxOps: number;
  /** Wall-clock deadline (epoch ms) after which the run stops and resumes next time. */
  deadline?: number;
}

export interface BuildDir {
  prefix: string;
  objects: number;
  newestUpload: number;
}

export interface GcReport {
  builds: BuildDir[];
  kept: string[];
  doomed: string[];
  deletedObjects: number;
  ops: number;
  complete: boolean;
  dryRun: boolean;
}

class OpsBudget {
  used = 0;
  constructor(
    private readonly max: number,
    private readonly deadline = Infinity,
  ) {}
  take(): boolean {
    if (this.used >= this.max || Date.now() >= this.deadline) return false;
    this.used++;
    return true;
  }
}

async function listBuildPrefixes(bucket: GcBucket, root: string, budget: OpsBudget): Promise<string[] | null> {
  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    if (!budget.take()) return null;
    const page = await bucket.list({ prefix: root, delimiter: "/", cursor });
    prefixes.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return prefixes;
}

async function scanBuild(bucket: GcBucket, prefix: string, budget: OpsBudget): Promise<BuildDir | null> {
  let objects = 0;
  let newestUpload = 0;
  let cursor: string | undefined;
  do {
    if (!budget.take()) return null;
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects += page.objects.length;
    for (const o of page.objects) newestUpload = Math.max(newestUpload, o.uploaded.getTime());
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { prefix, objects, newestUpload };
}

/** Pick doomed build dirs: not among the newest `keepNewest`, and idle long enough. */
export function selectDoomed(builds: BuildDir[], keepNewest: number, minIdleMs: number, now: number): string[] {
  const byNewest = [...builds].sort((a, b) => b.newestUpload - a.newestUpload);
  return byNewest
    .slice(keepNewest)
    .filter((b) => now - b.newestUpload >= minIdleMs)
    .map((b) => b.prefix);
}

async function deletePrefix(bucket: GcBucket, prefix: string, budget: OpsBudget): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  // Always re-list from the start: deleting shifts pagination.
  for (;;) {
    if (!budget.take()) return { deleted, complete: false };
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length === 0) return { deleted, complete: true };
    if (!budget.take()) return { deleted, complete: false };
    await bucket.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
  }
}

export async function gcNextCache(bucket: GcBucket, opts: GcOptions): Promise<GcReport> {
  const budget = new OpsBudget(opts.maxOps, opts.deadline);
  const report: GcReport = {
    builds: [],
    kept: [],
    doomed: [],
    deletedObjects: 0,
    ops: 0,
    complete: false,
    dryRun: opts.dryRun,
  };
  const finish = () => ({ ...report, ops: budget.used });

  const prefixes = await listBuildPrefixes(bucket, opts.root, budget);
  if (!prefixes) return finish();
  for (const prefix of prefixes) {
    const build = await scanBuild(bucket, prefix, budget);
    // Never decide on a partial scan: an unscanned build might be the live one.
    if (!build) return finish();
    report.builds.push(build);
  }

  report.doomed = selectDoomed(report.builds, opts.keepNewest, opts.minIdleMs, opts.now);
  report.kept = report.builds.map((b) => b.prefix).filter((p) => !report.doomed.includes(p));
  if (opts.dryRun) {
    report.complete = true;
    return finish();
  }
  for (const prefix of report.doomed) {
    const { deleted, complete } = await deletePrefix(bucket, prefix, budget);
    report.deletedObjects += deleted;
    if (!complete) return finish();
  }
  report.complete = true;
  return finish();
}
