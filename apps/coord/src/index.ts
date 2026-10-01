/**
 * ghfind-coord: hosts the Durable Objects that replace Upstash Redis for
 * coordination (callers bind the classes cross-script via `script_name`), and
 * runs scheduled housekeeping. The Worker serves no HTTP routes.
 */
import { gcNextCache, type GcBucket, type GcReport } from "./next-cache-gc";

export { KeyValue } from "./key-value";
export { RateLimiter } from "./rate-limiter";
export { ScanCapacity } from "./scan-capacity";
export { ScanSlot } from "./scan-slot";

interface Env {
  /** The legacy Next Worker's OpenNext incremental cache bucket for this env. */
  NEXT_INC_CACHE_R2_BUCKET?: GcBucket;
  NEXT_CACHE_GC_KEEP_NEWEST?: string;
  NEXT_CACHE_GC_MIN_IDLE_DAYS?: string;
  /** "0" to actually delete; anything else only logs the plan. */
  NEXT_CACHE_GC_DRY_RUN?: string;
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },

  async scheduled(controller, env) {
    const bucket = env.NEXT_INC_CACHE_R2_BUCKET;
    if (!bucket) return;
    const started = Date.now();
    const summarize = (report: GcReport) => {
      const dir = (prefix: string) => {
        const b = report.builds.find((x) => x.prefix === prefix)!;
        return { prefix, objects: b.objects, lastWrite: new Date(b.newestUpload).toISOString() };
      };
      return {
        event: "next_cache_gc",
        cron: controller.cron,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        dryRun: report.dryRun,
        complete: report.complete,
        ops: report.ops,
        deletedObjects: report.deletedObjects,
        builds: report.builds.length,
        doomed: report.doomed.map(dir),
        kept: report.kept.map(dir),
      };
    };
    let summary: Record<string, unknown>;
    try {
      const report = await gcNextCache(bucket, {
        root: "incremental-cache/",
        keepNewest: Number(env.NEXT_CACHE_GC_KEEP_NEWEST ?? 3),
        minIdleMs: Number(env.NEXT_CACHE_GC_MIN_IDLE_DAYS ?? 7) * 86_400_000,
        now: started,
        dryRun: env.NEXT_CACHE_GC_DRY_RUN !== "0",
        // Stay well under per-invocation limits; unfinished work resumes next run.
        maxOps: 900,
        deadline: started + 5 * 60_000,
      });
      summary = summarize(report);
    } catch (error) {
      summary = {
        event: "next_cache_gc",
        cron: controller.cron,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
    console.log(JSON.stringify(summary));
    // Outside incremental-cache/, so the GC never scans or deletes it. Read with
    // `wrangler r2 object get <bucket>/gc-reports/last.json --remote --pipe`.
    await bucket.put("gc-reports/last.json", JSON.stringify(summary, null, 2));
  },
} satisfies ExportedHandler<Env>;
