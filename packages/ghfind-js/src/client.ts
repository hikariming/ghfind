import type {
  ByoKey,
  DeveloperFacet,
  GitHubUser,
  LeaderboardResponse,
  LeaderboardView,
  LeaderboardWindow,
  RoastMeta,
  RoastResult,
  ScanResult,
  ScorePayload,
  SearchUsersResponse,
  StatsResponse,
} from "./types.js";

const ROAST_META_HEADER = "x-roast-meta";
const FRAME = "\x1f";
const DEFAULT_HOST = "https://ghfind.com";
const GITHUB_API = "https://api.github.com";
const SCAN_JOB_TIMEOUT_MS = 75_000;
const SCAN_JOB_POLL_MS = 1_000;

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

export interface GhFindOptions {
  /** Base URL of the ghfind deployment. Defaults to `GHFIND_HOST`, then the
   * legacy `GITHUB_ROAST_HOST` env var, then `https://ghfind.com`. */
  host?: string;
  /** Machine API key sent as `Authorization: Bearer <key>` (bypasses Turnstile on
   * POST /api/scan in production). */
  apiKey?: string;
  /** Cloudflare Turnstile token for browser callers of POST /api/scan. */
  turnstileToken?: string;
  /** Optional GitHub token for the client-side existence check. Not required —
   * without it, GitHub's public API is used (~60 req/h per IP). With it, the
   * check runs at your own GitHub rate limit (5000/h). Never sent to ghfind. */
  githubToken?: string;
  /** Custom fetch implementation (for tests / non-standard runtimes). Defaults to
   * the global `fetch`. */
  fetch?: FetchLike;
}

/** Thrown for any non-2xx API response (and roast-stream errors). */
export class GhFindError extends Error {
  status?: number;
  code?: string | null;
  body?: unknown;
  constructor(
    message: string,
    opts: { status?: number; code?: string | null; body?: unknown } = {},
  ) {
    super(message);
    this.name = "GhFindError";
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.body = opts.body;
  }
}

function decodeMeta(value: string | null): RoastMeta | null {
  if (!value) return null;
  try {
    const bytes =
      typeof atob === "function"
        ? Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
        : // Node fallback
          new Uint8Array(Buffer.from(value, "base64"));
    const text = new TextDecoder("utf-8").decode(bytes);
    return JSON.parse(text) as RoastMeta;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Official client for the ghfind API (https://ghfind.com).
 *
 * Every method is an atomic capability backed by one public endpoint. Scoring
 * (`scan`, `score`, `getScore`, `vs` winner) is deterministic and never calls an
 * LLM. Only `roast`/`vs` *prose* uses an LLM, and `roast` accepts a
 * bring-your-own key so you can run it through your own model.
 */
export class GhFind {
  readonly host: string;
  private readonly apiKey?: string;
  private readonly turnstileToken?: string;
  private readonly githubToken?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GhFindOptions = {}) {
    const raw = (
      options.host ||
      (typeof process !== "undefined" ? process.env?.GHFIND_HOST : undefined) ||
      (typeof process !== "undefined" ? process.env?.GITHUB_ROAST_HOST : undefined) ||
      DEFAULT_HOST
    ).trim();
    this.host = raw.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.turnstileToken = options.turnstileToken;
    this.githubToken = options.githubToken;
    const f = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) {
      throw new GhFindError(
        "No fetch implementation available. Pass `fetch` in options (Node <18 or non-standard runtime).",
      );
    }
    this.fetchImpl = f;
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  private async readError(response: {
    status: number;
    text(): Promise<string>;
  }): Promise<never> {
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text for diagnostics */
    }
    const code =
      parsed && typeof parsed === "object" && "error" in parsed
        ? ((parsed as { error?: string }).error ?? null)
        : null;
    throw new GhFindError(
      code ? `API request failed: ${code}` : `API request failed with HTTP ${response.status}`,
      { status: response.status, code, body: parsed ?? text },
    );
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.host}${path}`, { method: "GET" });
    if (!res.ok) await this.readError(res);
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) await this.readError(res);
    return (await res.json()) as T;
  }

  private absoluteURL(pathOrURL: string): string {
    return new URL(pathOrURL, `${this.host}/`).toString();
  }

  private async pollScanJob(location: string): Promise<ScanResult> {
    const deadline = Date.now() + SCAN_JOB_TIMEOUT_MS;
    let last: { status?: { state?: string; error?: string }; result?: ScanResult } | null = null;
    for (;;) {
      const res = await this.fetchImpl(this.absoluteURL(location), { method: "GET" });
      if (!res.ok) await this.readError(res);
      const payload = (await res.json()) as {
        status?: { state?: string; error?: string };
        result?: ScanResult;
      };
      last = payload;
      if (payload.result) return payload.result;
      if (payload.status?.state === "failed") {
        throw new GhFindError("Scan job failed", {
          status: res.status,
          code: payload.status.error || "scan_failed",
          body: payload,
        });
      }
      if (Date.now() >= deadline) {
        throw new GhFindError("Scan job timed out", {
          status: 202,
          code: "scan_timeout",
          body: last,
        });
      }
      await sleep(SCAN_JOB_POLL_MS);
    }
  }

  // ---- GitHub existence check (client-side; does NOT touch ghfind) -----------

  /**
   * Look up a GitHub account directly from GitHub's public API. Returns the basic
   * public profile, or `null` if the login does not exist (HTTP 404).
   *
   * Runs on the *caller's* IP/quota, not ghfind's — so you can confirm an account
   * is real before spending a call on the (heavier) scoring API. No token needed;
   * pass one (constructor `githubToken` or `opts.token`) to raise GitHub's
   * unauthenticated ~60/h limit to 5000/h. Throws {@link GhFindError} (code
   * `github_rate_limited`) if GitHub rate-limits the check so you don't mistake a
   * throttle for "not found".
   */
  async getGitHubUser(
    username: string,
    opts: { token?: string } = {},
  ): Promise<GitHubUser | null> {
    const token = opts.token ?? this.githubToken;
    const res = await this.fetchImpl(`${GITHUB_API}/users/${encodeURIComponent(username)}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
      throw new GhFindError("GitHub rate-limited the existence check", {
        status: res.status,
        code: "github_rate_limited",
      });
    }
    if (!res.ok) await this.readError(res);
    return (await res.json()) as GitHubUser;
  }

  /** Convenience boolean form of {@link getGitHubUser}. */
  async userExists(username: string, opts: { token?: string } = {}): Promise<boolean> {
    return (await this.getGitHubUser(username, opts)) !== null;
  }

  private async ensureExists(username: string, token?: string): Promise<void> {
    const user = await this.getGitHubUser(username, { token });
    if (!user) {
      throw new GhFindError(`GitHub user "${username}" does not exist`, {
        status: 404,
        code: "github_user_not_found",
      });
    }
  }

  // ---- Scoring (deterministic, no LLM) ---------------------------------------

  /** Full deterministic scan + score. Crawls GitHub server-side.
   *
   * Pass `{ verifyExists: true }` to first confirm the account is real via the
   * client-side GitHub check (above), so a typo/nonexistent handle fails fast
   * without hitting ghfind at all. */
  async scan(
    username: string,
    opts: { verifyExists?: boolean; githubToken?: string } = {},
  ): Promise<ScanResult> {
    if (opts.verifyExists) await this.ensureExists(username, opts.githubToken);
    const res = await this.fetchImpl(`${this.host}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        username,
        ...(this.turnstileToken ? { turnstileToken: this.turnstileToken } : {}),
      }),
    });
    if (!res.ok) await this.readError(res);
    if (res.status === 202) {
      const location = res.headers.get("location");
      if (!location) {
        throw new GhFindError("Scan job accepted without a status Location", {
          status: 202,
          code: "scan_status_missing",
        });
      }
      return this.pollScanJob(location);
    }
    return (await res.json()) as ScanResult;
  }

  /** Just the `scoring` block of a fresh scan (numeric score, tier, sub-scores,
   * red flags). Convenience over {@link scan}. */
  async score(
    username: string,
    opts: { verifyExists?: boolean; githubToken?: string } = {},
  ): Promise<ScanResult["scoring"]> {
    const result = await this.scan(username, opts);
    return result.scoring;
  }

  /** Deterministic score via GET /api/score/{username}. No auth, cacheable, never
   * calls an LLM. Indexed accounts return the stored payload (with tags/roast_line);
   * unseen accounts are admitted to the Go quick-scan worker path (`source: "quick"`,
   * includes red_flags, no LLM copy). A compatible old stored score may return
   * `source: "legacy_v5_v5_v3"` with `stale: true`. Throws {@link GhFindError}
   * with status 404 only when the GitHub login does not exist. The cheapest way
   * to get a score.
   *
   * Pass `{ verifyExists: true }` to confirm the account is real (client-side
   * GitHub check) before calling ghfind — avoids admitting worker work for a
   * handle that doesn't exist. */
  async getScore(
    username: string,
    opts: { verifyExists?: boolean; githubToken?: string } = {},
  ): Promise<ScorePayload> {
    if (opts.verifyExists) await this.ensureExists(username, opts.githubToken);
    return this.getJson<ScorePayload>(`/api/score/${encodeURIComponent(username)}`);
  }

  // ---- Roast (LLM; bring-your-own key supported) -----------------------------

  /**
   * Generate the human-facing roast report + AI-adjusted score.
   *
   * Pass a `scan` to reuse one you already have, otherwise a fresh {@link scan}
   * is run first (so it works even for accounts the server hasn't cached). Pass
   * `byoKey` to run the LLM through your own OpenAI-compatible provider.
   */
  async roast(
    input:
      | string
      | { username?: string; scan?: ScanResult; lang?: "zh" | "en"; byoKey?: ByoKey },
  ): Promise<RoastResult> {
    const opts = typeof input === "string" ? { username: input } : input;
    let scan = opts.scan;
    if (!scan) {
      if (!opts.username) {
        throw new GhFindError("roast requires a `username` or a `scan`");
      }
      scan = await this.scan(opts.username);
    }
    const res = await this.fetchImpl(`${this.host}/api/roast`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        scan,
        ...(opts.lang ? { lang: opts.lang } : {}),
        ...(opts.byoKey ? { byoKey: opts.byoKey } : {}),
      }),
    });
    if (!res.ok) await this.readError(res);
    return this.parseRoastStream(res);
  }

  private async parseRoastStream(res: {
    status: number;
    text(): Promise<string>;
    headers: { get(name: string): string | null };
  }): Promise<RoastResult> {
    const headerMeta = decodeMeta(res.headers.get(ROAST_META_HEADER));
    const text = await res.text();
    const reportLines: string[] = [];
    const progress: string[] = [];
    let meta = headerMeta;

    for (const line of text.split("\n")) {
      if (line.startsWith(`${FRAME}T`)) {
        progress.push(line.slice(2));
        continue;
      }
      if (line.startsWith(`${FRAME}M`)) {
        meta = decodeMeta(line.slice(2)) ?? meta;
        continue;
      }
      if (line.startsWith(`${FRAME}E`)) {
        const raw = line.slice(2);
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* keep raw */
        }
        throw new GhFindError("Roast stream failed", {
          status: res.status,
          code:
            parsed && typeof parsed === "object" && "error" in parsed
              ? ((parsed as { error?: string }).error ?? null)
              : null,
          body: parsed,
        });
      }
      reportLines.push(line);
    }

    return { meta, report: reportLines.join("\n").replace(/^\n+|\n+$/g, ""), progress };
  }

  // ---- Battle / PK -----------------------------------------------------------

  /** Head-to-head verdict for two scored accounts. Winner + bucket are
   * deterministic; savage prose is LLM (only when both clear the floor). */
  vs(a: string, b: string): Promise<{
    verdict: { zh: string; en: string } | null;
    advice?: unknown;
    winner?: string;
    bucket?: string;
    reason?: string;
  }> {
    return this.postJson("/api/vs-verdict", { a, b });
  }

  // ---- Discovery (deterministic, no LLM) -------------------------------------

  /** Ranked public profiles. */
  leaderboard(
    opts: { view?: LeaderboardView; window?: LeaderboardWindow } = {},
  ): Promise<LeaderboardResponse> {
    const p = new URLSearchParams();
    if (opts.view) p.set("view", opts.view);
    if (opts.window) p.set("window", opts.window);
    return this.getJson(`/api/leaderboard${p.size ? `?${p}` : ""}`);
  }

  /** Discover developers by language / org / repo. Omit `value` to list the
   * available facet categories. */
  developers(opts: { type: DeveloperFacet; value?: string }): Promise<unknown> {
    const p = new URLSearchParams({ type: opts.type });
    if (opts.value) p.set("value", opts.value);
    return this.getJson(`/api/developers?${p}`);
  }

  /** Prefix autocomplete over scored accounts. */
  searchUsers(q: string): Promise<SearchUsersResponse> {
    return this.getJson(`/api/search-users?q=${encodeURIComponent(q)}`);
  }

  /** Platform totals (number of scored accounts). */
  stats(): Promise<StatsResponse> {
    return this.getJson("/api/stats");
  }

  // ---- Image URL builders (pure, no request) ---------------------------------

  /** URL of the SVG score badge (for READMEs). */
  badgeUrl(username: string, opts: { lang?: "zh" | "en" } = {}): string {
    const q = opts.lang ? `?lang=${opts.lang}` : "";
    return `${this.host}/api/badge/${encodeURIComponent(username)}${q}`;
  }

  /** URL of the 1200x630 OG card PNG for an account. */
  cardUrl(username: string): string {
    return `${this.host}/api/card/${encodeURIComponent(username)}`;
  }

  /** URL of the versus OG card PNG for two accounts. */
  vsCardUrl(a: string, b: string): string {
    return `${this.host}/api/card/vs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`;
  }
}
