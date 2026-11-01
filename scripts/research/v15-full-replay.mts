import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { collect as newCollect, type CollectOptions } from "../../src/lib/github";
import { score as newScore } from "../../src/lib/score";

type ScoreInputs = Parameters<NonNullable<CollectOptions["recordScoreInputs"]>>[0];
interface ResponseRecord { status: number; body: string; unavailable_contributor_list?: boolean }
interface SampleRow { username: string }
interface ProxyDispatcher { close(): Promise<void> }
interface HttpRuntime {
  ProxyAgent: new (options: { uri: string; connections: number }) => ProxyDispatcher;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; dispatcher: ProxyDispatcher }): Promise<{ status: number; headers: Headers; text(): Promise<string> }>;
}
const require = createRequire(import.meta.url);
const runtime = createRequire(require.resolve("wrangler/package.json"))("undici") as HttpRuntime;
const dispatcher = new runtime.ProxyAgent({ uri: "http://127.0.0.1:1082", connections: 4 });

const candidateHash = createHash("sha256").update([
  "src/lib/github.ts", "src/lib/presentation-concentration.ts", "src/lib/co-creator.ts", "src/lib/score.ts",
].map(path => readFileSync(path, "utf8")).join("\n")).digest("hex");
const baseline = process.env.V15_BASELINE_REF ?? "2010358b9e0360f13d88a2f696f73dd8ff64b60d";
// The pinned scorer's remaining runtime dependencies must still be identical.
execFileSync("git", ["diff", "--quiet", baseline, "--", "src/lib/risk.ts", "src/lib/score-presentation.ts"]);
const tempScore = resolve(`src/lib/.v15-replay-${process.pid}-score.ts`);
const tempGithub = resolve(`src/lib/.v15-replay-${process.pid}-github.ts`);
writeFileSync(tempScore, execFileSync("git", ["show", `${baseline}:src/lib/score.ts`]));
writeFileSync(tempGithub, execFileSync("git", ["show", `${baseline}:src/lib/github.ts`], { encoding: "utf8" })
  .replace('from "./score"', `from "./.v15-replay-${process.pid}-score"`));
const { score: oldScore } = await import(pathToFileURL(tempScore).href) as { score: typeof newScore };
const { collect: oldCollect } = await import(pathToFileURL(tempGithub).href) as { collect: typeof newCollect };
process.on("exit", () => {
  for (const path of [tempScore, tempGithub]) if (existsSync(path)) unlinkSync(path);
});
process.env.GITHUB_TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

const directory = process.env.V15_REPLAY_DIR ?? "/tmp/v15-full-replay";
mkdirSync(`${directory}/http`, { recursive: true });
const maxRequests = Number(process.env.V15_MAX_REQUESTS ?? 4500);
if (!Number.isInteger(maxRequests) || maxRequests < 200 || maxRequests > 4500) {
  throw new Error("Request budget must be between 200 and 4500");
}
const httpSlots = Number(process.env.V15_HTTP_SLOTS ?? 4);
if (![1,2,3,4].includes(httpSlots)) throw new Error("HTTP slots must be 1–4");
let active = 0;
let requests = 0;
let quotaLow = false;
let cooldownUntil = 0;
let rateEpoch = 0;
const queue: (() => void)[] = [];
const cache = new Map<string, Promise<ResponseRecord>>();
async function acquire() {
  if (active < httpSlots) { active++; return; }
  await new Promise<void>(resolve => queue.push(resolve));
}
function release() {
  const next = queue.shift();
  if (next) next();
  else active--;
}

async function request(url: string, init: RequestInit, body: string | undefined): Promise<ResponseRecord> {
  await acquire();
  try {
    if (++requests > maxRequests) {
      quotaLow = true; // Reject every in-flight row; never accept partial evidence.
      throw new Error("Read-only replay request budget exhausted");
    }
    if (quotaLow) throw new Error("GitHub quota guard reached; resume after reset");
    // Reuse connections through the existing Wrangler HTTP runtime. Credentials
    // remain in memory and never enter argv, logs or the response cache.
    if (cooldownUntil > Date.now()) await new Promise(resolve => setTimeout(resolve, cooldownUntil - Date.now()));
    const timeout = AbortSignal.timeout(50_000);
    const response = await runtime.fetch(url, {
      method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), body,
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout, dispatcher,
    });
    const responseBody = await response.text();
    let message = "";
    try { message = String(JSON.parse(responseBody).message ?? ""); } catch { /* Non-JSON responses are not evidence of this documented API limit. */ }
    const unavailableContributors = response.status === 403 && /\/contributors\?/.test(url) &&
      message === "The history or contributor list is too large to list contributors for this repository via the API.";
    if ((response.status === 403 && !unavailableContributors) || response.status === 429) {
      rateEpoch++;
      const retrySeconds = Number(response.headers.get("retry-after") ?? 60);
      cooldownUntil = Date.now() + Math.max(60, Number.isFinite(retrySeconds) ? retrySeconds : 60) * 1000;
      let reason = "";
      try { reason = String(JSON.parse(responseBody).message ?? "").slice(0, 250); } catch { /* No response or credential dump. */ }
      console.log("GitHub rate limit: honoring cooldown before further reads", reason);
    }
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining !== null && Number(remaining) < 350) quotaLow = true;
    return { status: response.status, body: responseBody, ...(unavailableContributors ? {unavailable_contributor_list: true} : {}) };
  } finally { release(); }
}

globalThis.fetch = async (input, init = {}) => {
  if (typeof input !== "string" && !(input instanceof URL)) throw new Error("Expected a GitHub URL");
  const url = String(input);
  const parsed = new URL(url);
  const method = (init.method ?? "GET").toUpperCase();
  if (init.body != null && typeof init.body !== "string") throw new Error("Unsupported replay request body");
  let body = init.body ?? undefined;
  const query = body ? (JSON.parse(body) as { query?: string }).query : undefined;
  if (parsed.hostname !== "api.github.com" || (method !== "GET" && !(
    method === "POST" && parsed.pathname === "/graphql" && typeof query === "string" && /^\s*(query\b|\{)/.test(query)
  ))) throw new Error("Replay only permits GitHub reads");
  // Both formulas receive the same complete file facts; other queries stay exact.
  if (body && parsed.pathname === "/graphql") {
    body = body.replaceAll("files(first: 50) { nodes { path } }", "files(first: 100) { nodes { path additions deletions } }");
  }
  const key = createHash("sha256").update(`${url}\n${body ?? ""}`).digest("hex");
  const path = `${directory}/http/${key}.json`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as ResponseRecord;
      const result = await request(url, init, body);
      let errors = false;
      try { errors = Boolean((JSON.parse(result.body) as { errors?: unknown[] }).errors?.length); } catch { /* Non-JSON bodies are valid REST facts. */ }
      if ((result.status >= 200 && result.status < 300 && !errors) || result.status === 404 || result.unavailable_contributor_list) {
        writeFileSync(path, JSON.stringify(result));
      } else {
        cache.delete(key); // A later collector retry must make a fresh read.
      }
      return result;
    })();
    cache.set(key, pending);
  }
  const result = await pending;
  return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } });
};

let rows = JSON.parse(readFileSync(process.env.V15_SAMPLE_PATH ?? "/tmp/v15-sample.json", "utf8")) as SampleRow[];
if (rows.some(row => !/^[a-z\d][a-z\d-]{0,38}$/i.test(row.username))) throw new Error("Invalid sample username");
if (process.env.V15_REPLAY_ONLY_EXISTING === "1") {
  rows = rows.filter(row => existsSync(`${directory}/${row.username.toLowerCase()}.json`));
}
const controls = new Set(["lofisu", "yifanxuaaa", "samzong", "hikariming", "asperformias", "asukaminato0721"]);
rows.sort((a, b) => Number(controls.has(b.username.toLowerCase())) - Number(controls.has(a.username.toLowerCase())));
const now = new Date("2026-10-20T12:00:00Z");
async function replay(row: SampleRow) {
  const path = `${directory}/${row.username.toLowerCase()}.json`;
  if (process.env.V15_REPLAY_FORCE !== "1" && existsSync(path) && JSON.parse(readFileSync(path, "utf8")).candidate_hash === candidateHash && JSON.parse(readFileSync(path, "utf8")).rate_guarded === true) return;
  try {
    const startedRateEpoch = rateEpoch;
    let scoreInputs: ScoreInputs | undefined;
    const after = await newCollect(row.username, { now, deadlineMs: 300_000, recordScoreInputs: inputs => { scoreInputs = inputs; } });
    const before = await oldCollect(row.username, { now, deadlineMs: 300_000 });
    if (quotaLow || rateEpoch !== startedRateEpoch) throw new Error("Rate/quota guard interrupted this replay; result not accepted");
    writeFileSync(path, JSON.stringify({
      rate_guarded: true, candidate_hash: candidateHash, source_ref: baseline, username: row.username, score_inputs: scoreInputs,
      before: oldScore(before.metrics), after: newScore(after.metrics),
      before_metrics: before.metrics, after_metrics: after.metrics, recent_prs: after.recent_prs, top_repos: after.top_repos,
    }));
    console.log(row.username, "ok", requests);
  } catch (error) { console.log(row.username, "FAILED", (error instanceof Error ? `${error.name}: ${error.message} ${error.stack}` : String(error)).slice(0, 1200), requests); }
}
let next = 0;
try {
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < rows.length && requests < maxRequests - 100 && !quotaLow) await replay(rows[next++]);
  }));
} finally { await dispatcher.close(); }
