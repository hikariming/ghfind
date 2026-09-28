/**
 * Parity check of the TypeScript devscore collector (src/lib/devscore/collect) against
 * devscore's Python collector (collector/collect.py), scored by the Zig CLI.
 *
 *   pnpm tsx scripts/devscore-collect-parity.mts [--replay] <login>...
 *
 * Runs startCollect/stepCollect for each login with `gh auth token`, a filesystem CollectStore
 * under /tmp/ts-collect-store and a 20 s step deadline (forcing resumes), writes the Developer
 * to /tmp/ts-<login>.json (--replay: /tmp/ts-replay-<login>.json), then compares it field by field with the Python output and scores
 * both with `devscore --json`.
 *
 * Live (default): compares with $PY_DATA/<login>.json (default /tmp/dsparity/pyc/data), a
 * Python run from an earlier time: differences mix port bugs with live-data drift.
 * --replay: serves every request the Python collector has cached ($PY_CACHE, default
 * /tmp/dsparity/pyc/collector/.cache) under the Python cache key (so the query text must match
 * byte for byte), pins the collection time to the Python baseline's collected_at, and compares
 * with $PY_KEYS/<login>.json (default /tmp/dsparity/keys: pykeys.py replays with pinned dates).
 * Requests the Python cache lacks go to the network and are counted as misses.
 *
 * The TS collector fetches only what can change the score, so the comparison first drops from
 * the Python side the fields TS no longer emits (DROPPED_TOP / DROPPED_REPO / DROPPED_EXT_PR)
 * and skips differences where TS is null because a gate left the value out:
 * ext_prs[*].closed_by / additions / deletions / changed_files (slopNeedsClosers), ext_prs[*].reviewers (unreviewedCandidate) and
 * repos[*].star_history (hypeNeedsStarHistory). The Zig score comparison covers the rest: the
 * gates are only correct if both scores still agree. Queries the Python collector never sends
 * (the one all-states PR list scan, slimmer signals/repo meta queries, nodes(ids:) closers, sizes and reviewers) are replay
 * cache misses and go to the network.
 *
 * Env: DEVSCORE_DIR (default ../devscore) for zig-out/bin/devscore; STEP_MS overrides the step
 * deadline (a few hundred ms forces resumes inside phases in replay mode). Exits 1 on any difference.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startCollect, stepCollect, type CollectEnv, type CollectStore } from "../src/lib/devscore/collect";

const args = process.argv.slice(2);
const replay = args.includes("--replay");
const logins = args.filter((a) => !a.startsWith("--"));
if (!logins.length) {
  console.error("usage: pnpm tsx scripts/devscore-collect-parity.mts [--replay] <login>...");
  process.exit(2);
}
const STEP_MS = Number(process.env.STEP_MS ?? 20_000);
const STORE_DIR = replay ? "/tmp/ts-collect-store-replay" : "/tmp/ts-collect-store";
const PY_CACHE = process.env.PY_CACHE ?? "/tmp/dsparity/pyc/collector/.cache";
const PY_DIR = replay ? (process.env.PY_KEYS ?? "/tmp/dsparity/keys") : (process.env.PY_DATA ?? "/tmp/dsparity/pyc/data");
const devscoreDir = resolve(process.env.DEVSCORE_DIR ?? join(import.meta.dirname, "../../devscore"));
const cli = join(devscoreDir, "zig-out/bin/devscore");
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** CollectStore over one JSON file per key (expiry ignored: runs are minutes apart). */
function fsStore(dir: string): CollectStore {
  mkdirSync(dir, { recursive: true });
  const path = (key: string) => join(dir, sha1(key) + ".json");
  return {
    async get<T>(key: string) {
      return existsSync(path(key)) ? (JSON.parse(readFileSync(path(key), "utf8")) as T) : null;
    },
    async put(key: string, value: unknown) {
      writeFileSync(path(key), JSON.stringify(value));
    },
  };
}

/** Python json.dumps(value, sort_keys=True): ", " / ": " separators, ASCII-only output. */
function pyDumps(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(pyDumps).join(", ") + "]";
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => `${pyDumps(k)}: ${pyDumps(o[k])}`).join(", ") + "}";
  }
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** The Python collector's cache key of a request (collect.py rest/graphql/eco_get/_http_post). */
function pyKey(url: string, init?: RequestInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (url.startsWith("https://api.github.com/graphql")) {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
    return "GQL " + pyDumps({ query, variables });
  }
  if (url.startsWith("https://api.github.com/")) {
    const version = headers["X-GitHub-Api-Version"];
    return "REST " + url.slice("https://api.github.com/".length) + (version !== "2022-11-28" ? ` @${version}` : "");
  }
  if (url.startsWith("https://play.clickhouse.com/")) return "CH " + String(init?.body);
  return "ECO " + url;
}

const stats = { hit: 0, miss: 0, missKeys: [] as string[] };

/** fetch that answers from the Python cache when it has the request (replay mode). */
const replayFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const key = pyKey(url, init);
  const file = join(PY_CACHE, sha1(key) + ".json");
  if (existsSync(file)) {
    stats.hit += 1;
    if (process.env.TRACE) console.log(`   hit ${key.slice(0, 100)}`);
    const res = JSON.parse(readFileSync(file, "utf8")) as { status: number | null; link: string | null; body: string };
    if (res.status === null) throw new Error("cached transport failure");
    return new Response(res.body, { status: res.status, headers: res.link ? { link: res.link } : {} });
  }
  if (process.env.VERBOSE) console.log(`   fetch miss ${key.slice(0, 120)}`);
  stats.miss += 1;
  stats.missKeys.push(key.slice(0, 200));
  return fetch(input, init);
}) as typeof fetch;

/** Fields the Python collector writes that the TS collector does not collect (never scored). */
const DROPPED_TOP = ["account_created_at", "restricted_by_year"];
const DROPPED_REPO = ["archived", "created_at", "primary_language", "issues_total", "prs_total", "review_depth", "dependent_repos"];
const DROPPED_EXT_PR = ["closed_at", "merged_at", "association"];

function omit(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
}

/** A difference at `path` only because TS left a gated field null. */
function gatedOut(path: string, ts: unknown): boolean {
  return ts === null && /^(\.ext_prs\[\d+\]\.(closed_by|reviewers|additions|deletions|changed_files)|repos\[[^\]]+\]\.star_history)$/.test(path);
}

/** Paths of every leaf that differs; arrays compared elementwise, objects over the union of keys. */
function diff(py: unknown, ts: unknown, path: string, out: string[]): void {
  if (gatedOut(path, ts)) return;
  if (typeof py === "number" && typeof ts === "number") {
    if (Math.abs(py - ts) > 1e-9) out.push(`${path}: py ${py} ts ${ts}`);
    return;
  }
  if (Array.isArray(py) && Array.isArray(ts)) {
    if (py.length !== ts.length) out.push(`${path}: length py ${py.length} ts ${ts.length}`);
    for (let i = 0; i < Math.min(py.length, ts.length); i++) diff(py[i], ts[i], `${path}[${i}]`, out);
    return;
  }
  if (py !== null && ts !== null && typeof py === "object" && typeof ts === "object" && !Array.isArray(py) && !Array.isArray(ts)) {
    const p = py as Record<string, unknown>;
    const t = ts as Record<string, unknown>;
    for (const k of new Set([...Object.keys(p), ...Object.keys(t)])) {
      if (!(k in p) || !(k in t)) out.push(`${path}.${k}: only in ${k in p ? "py" : "ts"}`);
      else diff(p[k], t[k], `${path}.${k}`, out);
    }
    return;
  }
  if (JSON.stringify(py) !== JSON.stringify(ts)) out.push(`${path}: py ${JSON.stringify(py)?.slice(0, 160)} ts ${JSON.stringify(ts)?.slice(0, 160)}`);
}

/** Repo lists compared by name (order checked separately), so one missing repo does not shift every index. */
function compareDevelopers(py: Record<string, unknown>, ts: Record<string, unknown>): string[] {
  const out: string[] = [];
  const { repos: pyRepos, ...pyTop } = py as { repos: Record<string, unknown>[] };
  const { repos: tsRepos, ...tsTop } = ts as { repos: Record<string, unknown>[] };
  const pyExt = pyTop.ext_prs as Record<string, unknown>[] | null | undefined;
  diff({ ...omit(pyTop, DROPPED_TOP), ext_prs: pyExt?.map((x) => omit(x, DROPPED_EXT_PR)) ?? pyExt }, tsTop, "", out);
  const byName = new Map(tsRepos.map((r) => [r.name as string, r]));
  for (const r of pyRepos) {
    const t = byName.get(r.name as string);
    if (!t) out.push(`repos[${r.name}]: only in py`);
    else diff(omit(r, DROPPED_REPO), t, `repos[${r.name}]`, out);
  }
  const pyNames = new Set(pyRepos.map((r) => r.name));
  for (const r of tsRepos) if (!pyNames.has(r.name)) out.push(`repos[${r.name}]: only in ts`);
  const pyOrder = pyRepos.map((r) => r.name).filter((n) => byName.has(n as string));
  const tsOrder = tsRepos.map((r) => r.name).filter((n) => pyNames.has(n));
  if (JSON.stringify(pyOrder) !== JSON.stringify(tsOrder)) out.push("repos: order differs");
  return out;
}

function score(file: string): number {
  const line = execFileSync(cli, ["--json", file], { cwd: devscoreDir, encoding: "utf8", maxBuffer: 1 << 28 }).trim();
  return (JSON.parse(line) as { engine: { score: number } }).engine.score;
}

let failed = false;
for (const login of logins) {
  const pyFile = join(PY_DIR, `${login}.json`);
  const py = JSON.parse(readFileSync(pyFile, "utf8")) as Record<string, unknown>;
  const env: CollectEnv = {
    fetch: replay ? replayFetch : fetch,
    githubTokens: [execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()],
    store: fsStore(STORE_DIR),
    now: Date.now,
    log: process.env.VERBOSE ? (m) => console.log(m) : undefined,
  };
  Object.assign(stats, { hit: 0, miss: 0, missKeys: [] });
  let state = startCollect(login, replay ? Date.parse(py.collected_at as string) : Date.now());
  let steps = 0;
  const t0 = Date.now();
  let developer: Record<string, unknown>;
  while (true) {
    steps += 1;
    const step = await stepCollect(state, env, Date.now() + STEP_MS);
    if (step.done) {
      developer = step.developer as unknown as Record<string, unknown>;
      break;
    }
    state = step.state;
    if (state.waitUntil) {
      const { promise, resolve: wake } = Promise.withResolvers<void>();
      setTimeout(wake, Math.max(0, state.waitUntil - Date.now()));
      await promise;
    }
  }
  const tsFile = replay ? `/tmp/ts-replay-${login}.json` : `/tmp/ts-${login}.json`;
  writeFileSync(tsFile, JSON.stringify(developer, null, 2) + "\n");
  const diffs = compareDevelopers(py, developer);
  const pyScore = score(pyFile);
  const tsScore = score(tsFile);
  failed ||= diffs.length > 0;
  console.log(
    `== ${login}: ${steps} steps, ${((Date.now() - t0) / 1000).toFixed(1)} s` +
      (replay ? `, python cache hits ${stats.hit}, misses ${stats.miss}` : "") +
      `; score py ${pyScore.toFixed(4)} ts ${tsScore.toFixed(4)} (diff ${(tsScore - pyScore).toFixed(4)}); ${diffs.length} differing fields`,
  );
  for (const k of stats.missKeys.slice(0, 10)) console.log(`   miss ${k}`);
  for (const d of diffs.slice(0, 60)) console.log(`   ${d}`);
  if (diffs.length > 60) console.log(`   … ${diffs.length - 60} more`);
}
process.exit(failed ? 1 : 0);
