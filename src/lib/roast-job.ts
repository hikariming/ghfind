/**
 * Client for the RoastJob Durable Object (apps/coord). One object per profile
 * and language. The HTTP handler claims or attaches; the object's alarm runs
 * generation on ghfind-api, so a closed browser does not cancel the chain.
 *
 * Absent when coordination is not on Durable Objects, or this deploy has no
 * ROAST_JOB binding yet. Callers then keep the in-request chain.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ROAST_CACHE_VERSION } from "./cache-version";
import type { Lang } from "./lang";

export type RoastJobState = "running" | "done" | "failed";

export interface RoastJobRecord {
  state: RoastJobState;
  username: string;
  lang: string;
  startedAt: number;
  updatedAt: number;
  stage: string;
  fallback: "v12" | null;
  reason?: string;
}

export interface RoastJobClaim {
  job: RoastJobRecord;
  /** False when another request already owns this profile's chain. */
  started: boolean;
  /** False when the object has no API binding, so the caller generates inline. */
  binding: boolean;
}

interface RoastJobStub {
  claim(username: string, lang: string): Promise<RoastJobClaim>;
  status(): Promise<RoastJobRecord | null>;
  owner(): Promise<string | null>;
  note(stage: string): Promise<RoastJobRecord | null>;
  finish(ok: boolean, reason?: string): Promise<RoastJobRecord | null>;
  abandon(reason: string): Promise<RoastJobRecord | null>;
}

interface RoastJobNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): RoastJobStub;
}

export function roastJobKey(username: string, lang: Lang): string {
  return `roast:${ROAST_CACHE_VERSION}:${lang}:${username.toLowerCase()}`;
}

export function roastJobs(): RoastJobNamespace | null {
  if (process.env.GHFIND_COORD_BACKEND !== "do") return null;
  try {
    const env = getCloudflareContext().env as { ROAST_JOB?: RoastJobNamespace };
    return env.ROAST_JOB ?? null;
  } catch {
    return null;
  }
}

export function roastJob(username: string, lang: Lang): RoastJobStub | null {
  const jobs = roastJobs();
  if (!jobs) return null;
  const key = roastJobKey(username, lang);
  return jobs.get(jobs.idFromName(key));
}
