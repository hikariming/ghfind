/**
 * devscore collector transport (port of collector/collect.py "transport"): GitHub REST and
 * GraphQL, ecosyste.ms and ClickHouse play, all through one response cache in the
 * `CollectStore` so a retried or resumed step replays answers instead of refetching.
 *
 * Differences from the Python process, forced by the Worker runtime:
 * - no sleeping past the step deadline: a rate limit throws `CollectPause` with the
 *   time to resume; the runner persists the state and comes back later;
 * - concurrency is bounded per step by `pool()` instead of process-wide semaphores.
 */
import type { CollectEnv } from "./types";

export const RETRIES = 4;
export const GQL_CONCURRENCY = 6;
export const REST_CONCURRENCY = 10;
/** Seconds to back off on a secondary rate limit without retry-after. */
export const SECONDARY_WAIT = 60;
/** Cached HTTP answers live this long (the Python cache never expires; runs are days apart). */
export const HTTP_TTL_SECONDS = 7 * 24 * 3600;
const GITHUB_API = "https://api.github.com/";

/** An HTTP answer in the cache shape: status null = transport failure. */
export interface Res {
  status: number | null;
  link: string | null;
  body: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: string,
  ) {
    super(`api error ${status}: ${body.slice(0, 200)}`);
  }
}

/** Resume no earlier than `until` (epoch ms): a rate limit or the step deadline. */
export class CollectPause extends Error {
  constructor(
    readonly until: number,
    readonly why: string,
  ) {
    super(`pause until ${new Date(until).toISOString()}: ${why}`);
  }
}

const TRANSIENT =
  /(Something went wrong while executing your query|timedout|timed out|secondary rate limit|API rate limit exceeded|Server Error)/i;

export function isTransient(body: string): boolean {
  return TRANSIENT.test(body);
}

async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Per-step transport context: the env plus the deadline and a round-robin token cursor. */
export class Http {
  private tokenCursor = 0;
  /** Uncached calls made in this step, by API (for budgeting subrequests). */
  readonly calls = { rest: 0, graphql: 0, eco: 0, ch: 0 };

  constructor(
    readonly env: CollectEnv,
    readonly deadlineMs: number,
  ) {
    if (env.githubTokens.length === 0) throw new Error("devscore collect: no GitHub token");
  }

  /** Throws `CollectPause` when the step is out of time, so work resumes in the next step. */
  checkDeadline(): void {
    if (this.env.now() >= this.deadlineMs) throw new CollectPause(this.deadlineMs, "step deadline");
  }

  private log(msg: string): void {
    this.env.log?.(msg);
  }

  /**
   * fetch() → Res through the cache: 5xx and transport failures are never cached. A REST 2xx
   * body is an answer even if it says "timed out" (a commit diff can); GraphQL reports server
   * failures inside a 200, so its bodies are always checked.
   */
  async cached(key: string, fetchOnce: () => Promise<Res>): Promise<Res> {
    const storeKey = `http:${await sha1(key)}`;
    const hit = await this.env.store.get<Res>(storeKey);
    if (hit) return hit;
    let last: Res = { status: null, link: null, body: "no attempt" };
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      this.checkDeadline();
      const res = await fetchOnce();
      const okRest = key.startsWith("REST ") && res.status !== null && res.status >= 200 && res.status < 300;
      if (res.status !== null && res.status < 500 && (okRest || !isTransient(res.body))) {
        await this.env.store.put(storeKey, res, HTTP_TTL_SECONDS);
        return res;
      }
      last = res;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1500 * (attempt + 1));
      await promise;
    }
    return last;
  }

  /**
   * One GitHub call: REST GET `path`, or GraphQL POST of `payload`. Primary and secondary
   * rate limits rotate to the next token; when every token is limited the step pauses until
   * the earliest reset (Python: sleeps). Throttles never reach the cache.
   */
  private async gh(path: string, payload: string | null, version: string): Promise<Res> {
    const tokens = this.env.githubTokens;
    let earliest = Number.POSITIVE_INFINITY;
    let why = "";
    for (let tried = 0; tried < tokens.length; tried += 1) {
      const token = tokens[this.tokenCursor % tokens.length];
      this.tokenCursor += 1;
      const kind = payload === null ? "rest" : "graphql";
      this.calls[kind] += 1;
      let response: Response;
      try {
        response = await this.env.fetch(GITHUB_API + path, {
          method: payload === null ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": version,
            "User-Agent": "devscore/0.1",
            ...(payload === null ? {} : { "Content-Type": "application/json" }),
          },
          body: payload ?? undefined,
        });
      } catch (error) {
        return { status: null, link: null, body: String(error) };
      }
      const body = await response.text();
      if (response.status === 403 || response.status === 429) {
        const now = this.env.now();
        if (response.headers.get("x-ratelimit-remaining") === "0") {
          const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000 + 5000;
          earliest = Math.min(earliest, Math.max(reset, now + 5000));
          why = "rate limit exhausted";
          continue;
        }
        const retry = response.headers.get("retry-after");
        if (retry || body.toLowerCase().includes("secondary rate limit")) {
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : SECONDARY_WAIT;
          earliest = Math.min(earliest, now + seconds * 1000);
          why = "secondary rate limit";
          continue;
        }
      }
      return { status: response.status, link: response.headers.get("link"), body };
    }
    this.log(`  ~ GitHub ${why} on all ${tokens.length} tokens; pausing`);
    throw new CollectPause(earliest, why);
  }

  /** GET a REST path; returns [json, link]. Raises ApiError on non-2xx. */
  async rest<T = unknown>(path: string, version?: string): Promise<[T, string | null]> {
    const key = "REST " + path + (version ? ` @${version}` : "");
    const res = await this.cached(key, () => this.gh(path, null, version ?? "2022-11-28"));
    if (res.status === null || res.status >= 300) throw new ApiError(res.status, res.body);
    return [(res.body.trim() ? JSON.parse(res.body) : []) as T, res.link];
  }

  /** POST GraphQL; returns data (partial data allowed). Raises ApiError when there is none. */
  async graphql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    // key parity with Python's json.dumps(sort_keys=True) is not needed: caches are separate
    const payload = JSON.stringify({ query, variables: sortKeys(variables) });
    const res = await this.cached("GQL " + payload, () => this.gh("graphql", payload, "2022-11-28"));
    let doc: { data?: T | null; errors?: { type?: string }[] };
    try {
      doc = JSON.parse(res.body);
    } catch {
      throw new ApiError(res.status, res.body);
    }
    if (res.status === null || res.status >= 300 || doc.data === null || doc.data === undefined) {
      throw new ApiError(res.status, res.body);
    }
    const errors = (doc.errors ?? []).filter((e) => e.type !== "NOT_FOUND" && e.type !== "FORBIDDEN");
    if (errors.length > 0 && isTransient(JSON.stringify(errors))) throw new ApiError(502, JSON.stringify(errors));
    return doc.data;
  }

  /**
   * Cached ecosyste.ms GET: parsed JSON on 2xx, null otherwise (404, 5xx, transport failure).
   * A 429 pauses the step until the window resets (Python: waits ≤ 15 min), so a throttle is
   * never mistaken for "no package". Package lists are cached with only the fields the
   * collector reads (`slimEcoPackages`): a monorepo's full page can be tens of MB.
   */
  async ecoGet<T = unknown>(url: string): Promise<T | null> {
    const res = await this.cached("ECO " + url, async () => {
      this.calls.eco += 1;
      let response: Response;
      try {
        response = await this.env.fetch(url, { headers: { "User-Agent": "devscore/0.1", Accept: "application/json" } });
      } catch (error) {
        return { status: null, link: null, body: String(error) };
      }
      if (response.status === 429) {
        const retry = response.headers.get("retry-after") ?? "";
        const reset = response.headers.get("x-ratelimit-reset") ?? "";
        const now = this.env.now();
        const waitS = /^\d+$/.test(retry)
          ? Number(retry)
          : /^\d+$/.test(reset) && Number(reset) > 1e9
            ? Number(reset) - now / 1000
            : /^\d+$/.test(reset)
              ? Number(reset)
              : 60;
        throw new CollectPause(now + Math.min(900, Math.max(5, waitS)) * 1000, "ecosyste.ms 429");
      }
      const body = await response.text();
      if (!response.ok) return { status: response.status, link: null, body };
      return { status: response.status, link: null, body: slimEcoPackages(body) };
    });
    if (res.status === null || res.status < 200 || res.status >= 300) return null;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      return null;
    }
  }

  /**
   * ClickHouse play POST (not GitHub quota). Any non-2xx (quota, overload, bad query) is
   * status null: never cached, the caller treats it as unknown.
   */
  async clickhouse(sql: string): Promise<Res> {
    return this.cached("CH " + sql, async () => {
      this.calls.ch += 1;
      try {
        const response = await this.env.fetch("https://play.clickhouse.com/?user=play", {
          method: "POST",
          headers: { "User-Agent": "devscore/0.1" },
          body: sql,
        });
        const body = await response.text();
        return { status: response.ok ? response.status : null, link: null, body };
      } catch (error) {
        return { status: null, link: null, body: String(error) };
      }
    });
  }

  /**
   * run(chunk) over `items`; on an ApiError split the chunk in half and retry, giving up on
   * single items (Python `halving`). CollectPause propagates. Results merge in chunk order.
   */
  async halving<T, R>(items: T[], run: (chunk: T[]) => Promise<Map<string, R>>, label: string): Promise<Map<string, R>> {
    const out = new Map<string, R>();
    const stack: T[][] = [items];
    while (stack.length > 0) {
      const chunk = stack.pop()!;
      if (chunk.length === 0) continue;
      try {
        for (const [k, v] of await run(chunk)) out.set(k, v);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (chunk.length === 1) {
          this.log(`  ! ${label}: giving up on ${String(chunk[0])}: ${error.message}`);
          continue;
        }
        const mid = Math.floor(chunk.length / 2);
        this.log(`  ~ ${label}: halving batch of ${chunk.length} (${error.status})`);
        stack.push(chunk.slice(0, mid), chunk.slice(mid));
      }
    }
    return out;
  }

  /** halving() over chunks of `size`, `workers` at a time; merged in chunk order. */
  async parHalving<T, R>(
    items: T[],
    size: number,
    run: (chunk: T[]) => Promise<Map<string, R>>,
    label: string,
    workers = GQL_CONCURRENCY,
  ): Promise<Map<string, R>> {
    const parts = chunks(items, size);
    const results = await pool(parts, workers, (part) => this.halving(part, run, label));
    const out = new Map<string, R>();
    for (const part of results) for (const [k, v] of part) out.set(k, v);
    return out;
  }
}

/** Keys sorted recursively, like Python's json.dumps(sort_keys=True), so equal queries share a cache key. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function chunks<T>(seq: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < seq.length; i += n) out.push(seq.slice(i, i + n));
  return out;
}

/** Maps `items` with at most `workers` in flight; results in input order. The first error wins. */
export async function pool<T, R>(items: T[], workers: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

export function monthStart(m: string): string {
  return `${m}-01T00:00:00Z`;
}

export function monthEnd(m: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(last).padStart(2, "0")}T23:59:59Z`;
}

export function linkHasNext(link: string | null): boolean {
  return Boolean(link && link.includes('rel="next"'));
}

/** GraphQL string literal. */
export function gqlStr(s: string): string {
  return JSON.stringify(s);
}

/** Package fields the collector reads (package_dependents, fetch_dependents); the rest is dropped. */
const ECO_PACKAGE_FIELDS = ["name", "repository_url", "dependent_packages_count", "dependent_repos_count"] as const;

/** Keeps only ECO_PACKAGE_FIELDS of each package in an ecosyste.ms package list; other bodies pass through. */
function slimEcoPackages(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(parsed)) return body;
  return JSON.stringify(
    parsed.map((p: unknown) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) return p;
      const src = p as Record<string, unknown>;
      return Object.fromEntries(ECO_PACKAGE_FIELDS.filter((k) => k in src).map((k) => [k, src[k]]));
    }),
  );
}
