import { DurableObject } from "cloudflare:workers";

/**
 * One v13 roast generation per profile and language. The HTTP request only
 * claims the job and streams progress; a Durable Object alarm calls
 * ghfind-api's RoastContinueEntrypoint, so generation survives the browser
 * closing. Alarms are not bound to the 30s CPU cap of the 2-minute cron.
 *
 * `idFromName` is `roast:{cacheVersion}:{lang}:{username}`. The object
 * serializes events, so two claims for the same profile attach to one job.
 */

export type RoastJobState = "running" | "done" | "failed";

export interface RoastJobRecord {
  state: RoastJobState;
  username: string;
  lang: string;
  /** Wall-clock start. Progress rings resume from this and never jump backward. */
  startedAt: number;
  updatedAt: number;
  stage: string;
  /** Set when the chain exceeds the foreground budget and v12 should run. */
  fallback: "v12" | null;
  reason?: string;
}

export interface RoastContinueApi {
  run(username: string, lang: string, owner: string): Promise<{ ok: boolean; status: string }>;
}

interface Env {
  /** ghfind-api RoastContinueEntrypoint — holds the LLM credentials. */
  ROAST_API?: RoastContinueApi;
}

const JOB_KEY = "job";
const OWNER_KEY = "owner";
/** Set while an alarm's RPC is in flight, so a retried alarm does not start a second chain. */
const RUNNING_KEY = "inflight";
/** How long a running record stays visible to a returning page. */
const JOB_TTL_MS = 20 * 60_000;
/** A finished record stays long enough for a refresh to read the outcome. */
const DONE_TTL_MS = 10 * 60_000;
/** Re-arm the alarm if the RPC throws, until the job itself expires. */
const RETRY_MS = 15_000;

export class RoastJob extends DurableObject<Env> {
  private read(): RoastJobRecord | null {
    const job = this.ctx.storage.kv.get<RoastJobRecord>(JOB_KEY);
    if (!job) return null;
    const ttl = job.state === "running" ? JOB_TTL_MS : DONE_TTL_MS;
    if (Date.now() - job.startedAt > ttl) {
      this.ctx.storage.kv.delete(JOB_KEY);
      this.ctx.storage.kv.delete(OWNER_KEY);
      this.ctx.storage.kv.delete(RUNNING_KEY);
      return null;
    }
    return job;
  }

  /**
   * Join the in-flight job, or start one. `started` is false when this call
   * attached to work another request already owns. Without an API binding the
   * caller must generate inline (`binding` is false).
   */
  claim(username: string, lang: string): { job: RoastJobRecord; started: boolean; binding: boolean } {
    const existing = this.read();
    if (existing && existing.state === "running") {
      return { job: existing, started: false, binding: Boolean(this.env.ROAST_API) };
    }
    const now = Date.now();
    const job: RoastJobRecord = {
      state: "running",
      username,
      lang,
      startedAt: now,
      updatedAt: now,
      stage: "",
      fallback: null,
    };
    const owner = crypto.randomUUID();
    this.ctx.storage.kv.put(JOB_KEY, job);
    this.ctx.storage.kv.put(OWNER_KEY, owner);
    if (this.env.ROAST_API) void this.ctx.storage.setAlarm(now);
    return { job, started: true, binding: Boolean(this.env.ROAST_API) };
  }

  /** Current record, or null once it has expired. */
  status(): RoastJobRecord | null {
    return this.read();
  }

  /** Owner token the alarm passes to the API. Null when this object did not start a job. */
  owner(): string | null {
    return this.read() ? (this.ctx.storage.kv.get<string>(OWNER_KEY) ?? null) : null;
  }

  /** Forward-only stage label. A late or empty label never rewinds the record. */
  note(stage: string): RoastJobRecord | null {
    const job = this.read();
    if (!job || job.state !== "running") return job;
    const label = stage.trim();
    if (label) job.stage = label;
    job.updatedAt = Date.now();
    this.ctx.storage.kv.put(JOB_KEY, job);
    return job;
  }

  /** Mark the chain finished. The report itself lives in the roast table. */
  finish(ok: boolean, reason?: string): RoastJobRecord | null {
    const job = this.read();
    if (!job) return null;
    job.state = ok ? "done" : "failed";
    job.fallback = ok ? null : job.fallback;
    job.reason = reason;
    job.updatedAt = Date.now();
    this.ctx.storage.kv.put(JOB_KEY, job);
    void this.ctx.storage.deleteAlarm();
    return job;
  }

  /**
   * The chain outlived the foreground budget. The alarm stops, and the
   * attached request falls back to v12. A second claim may start a new job.
   */
  abandon(reason: string): RoastJobRecord | null {
    const job = this.read();
    if (!job || job.state !== "running") return job;
    job.state = "failed";
    job.fallback = "v12";
    job.reason = reason;
    job.updatedAt = Date.now();
    this.ctx.storage.kv.put(JOB_KEY, job);
    void this.ctx.storage.deleteAlarm();
    return job;
  }

  async alarm(): Promise<void> {
    const job = this.read();
    const owner = this.ctx.storage.kv.get<string>(OWNER_KEY);
    if (!job || job.state !== "running" || !owner || !this.env.ROAST_API) return;
    // A repeated alarm (platform retry, or a second claim) must not start a
    // second model call while the first RPC is still generating.
    if (this.ctx.storage.kv.get(RUNNING_KEY) === owner) return;
    this.ctx.storage.kv.put(RUNNING_KEY, owner);
    try {
      await this.env.ROAST_API.run(job.username, job.lang, owner);
    } catch {
      // The RPC threw before it could finish the record. Clear the in-flight
      // mark and try again while the job is still inside its TTL. run()
      // no-ops if the owner is gone. A successful run leaves the mark set so
      // a duplicate alarm does not start a second chain.
      this.ctx.storage.kv.delete(RUNNING_KEY);
      const live = this.read();
      if (live?.state === "running") void this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    }
  }
}
