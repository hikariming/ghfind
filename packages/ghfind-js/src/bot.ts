/**
 * `ghfind bot` — manage the ghfind Review GitHub App on repositories you
 * administer, from a terminal or an agent. Talks to the bot's JSON API
 * (https://bot.ghfind.com/api/v1), authenticated with the same personal API
 * token format as `scan` (GHFIND_API_KEY), with the bot permission explicitly
 * selected when creating the token. The bot checks your current GitHub
 * repository permission on every request: reading needs write access, every
 * change needs admin.
 *
 * Destructive cleanup is two-step: `bot cleanup` only previews and returns a
 * confirm token valid for 10 minutes; `bot cleanup confirm` executes it.
 */
import { GhFindError } from "./client.js";

export const DEFAULT_BOT_HOST = "https://bot.ghfind.com";
const POLL_MS = 2000;
const PLAN_WAIT_MS = 120_000;
const RUN_WAIT_MS = 600_000;
const BOT_TOKEN_MESSAGE =
  'bot commands need a personal API token with the bot permission: create a new token with "Manage the ghfind Review bot" at https://ghfind.com/integrations and set GHFIND_API_KEY';

export interface BotOptions {
  host: string;
  apiKey?: string;
  output: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
}

type Json = Record<string, unknown>;

/** Bot-specific flags, read from the positionals the global parser left. */
export function parseBotArgs(args: string[]): { rest: string[]; opts: Record<string, string | boolean> } {
  const values = new Set([
    "--bot-host",
    "--issues",
    "--prs",
    "--comments-enabled",
    "--triage",
    "--prompt",
    "--allowed-labels",
    "--labels",
    "-n",
    "--limit",
  ]);
  const booleans = new Set(["--comments", "--delete-label-definitions", "--no-wait", "--wait"]);
  const rest: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg)) {
      const next = args[++i];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      opts[arg === "-n" ? "--limit" : arg] = next;
    } else if (booleans.has(arg)) opts[arg] = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown bot option: ${arg}`);
    else rest.push(arg);
  }
  return { rest, opts };
}

/** The token goes to this host, so only HTTPS, or plain HTTP on localhost. */
export function botHost(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid bot host: ${raw}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("Bot host must use https (plain http only for localhost)");
  return url.origin + url.pathname.replace(/\/+$/, "");
}
function repoArg(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new Error("Expected a repository as owner/name");
  return value;
}
function toggle(value: string | boolean | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error(`${name} expects on or off`);
}

export class BotClient {
  constructor(private o: BotOptions) {}

  async request(method: string, path: string, body?: unknown): Promise<Json> {
    const key = this.o.apiKey;
    if (!key || !key.startsWith("ghf_"))
      throw new GhFindError(
        BOT_TOKEN_MESSAGE,
        { code: "personal_token_required" },
      );
    const response = await (this.o.fetch ?? fetch)(`${this.o.host}/api/v1${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const code =
        data && typeof data === "object" && typeof (data as Json).error === "string"
          ? String((data as Json).error)
          : null;
      throw new GhFindError(code === "token_scope_required" ? BOT_TOKEN_MESSAGE : `bot API request failed with HTTP ${response.status}`, {
        status: response.status,
        code,
        body: data,
      });
    }
    return (data ?? {}) as Json;
  }
  /** Polls a cleanup until it leaves one of `states` or the wait runs out. */
  async waitCleanup(repo: string, id: string, states: string[], limit: number): Promise<Json> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const started = Date.now();
    let last: Json | null = null;
    for (;;) {
      let view: Json;
      try {
        view = await this.request("GET", `/repos/${repo}/cleanups/${id}`);
      } catch (error) {
        // The cleanup keeps running on the server; a busy GitHub quota or our
        // own rate limit only means "ask again later".
        const busy = error instanceof GhFindError && (error.status === 503 || error.status === 429);
        if (!busy) throw error;
        if (Date.now() - started >= limit) {
          if (last) return last;
          throw error;
        }
        await sleep(POLL_MS * 5);
        continue;
      }
      last = view;
      const state = String((view.cleanup as Json | undefined)?.state);
      if (!states.includes(state) || Date.now() - started >= limit) return view;
      await sleep(POLL_MS);
    }
  }
}

function summarize(print: (line: string) => void, payload: Json): void {
  const c = (payload.cleanup ?? payload) as Json;
  const s = (c.summary ?? {}) as Json;
  print(`cleanup ${c.id}: ${c.state}`);
  print(
    `  review: labels ${s.review_labels ?? 0}, intent labels ${s.triage_labels ?? 0}, comments ${s.comments ?? 0}, label definitions ${s.label_definitions ?? 0}${s.truncated ? " (truncated: run again afterwards)" : ""}`,
  );
  if (c.state === "running" || c.state === "done")
    print(`  progress: ${c.done} removed, ${c.skipped} skipped (preserved or already absent), of ${c.total}`);
  if (s.bot_active) print("  warning: score labels are still on; run `ghfind bot pause` first or new items get labelled again");
  if (c.result) print(`  result: ${c.result}`);
}

export async function runBot(args: string[], o: BotOptions): Promise<void> {
  const print = o.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (value: unknown) => print(JSON.stringify(value, null, 2));
  const { rest, opts } = parseBotArgs(args);
  const host = botHost(String(opts["--bot-host"] ?? o.host));
  const bot = new BotClient({ ...o, host });
  const [command, ...tail] = rest;
  const json = o.output === "json";

  switch (command) {
    case "whoami":
      return emit(await bot.request("GET", "/whoami"));
    case "status": {
      const repo = repoArg(tail[0]);
      const status = await bot.request("GET", `/repos/${repo}`);
      if (json) return emit(status);
      const s = status.settings as Json;
      const jobs = status.jobs as Json;
      const viewer = status.viewer as Json;
      print(`${repo} (you: ${viewer.login}, ${viewer.admin ? "admin" : "read only"})`);
      print(`  issues ${s.issues_enabled ? "on" : "off"}, PRs ${s.prs_enabled ? "on" : "off"}, comments ${s.comments_enabled ? "on" : "off"}, intent labels ${s.triage_enabled ? "on" : "off"}${status.llm_configured ? "" : " (LLM not configured)"}`);
      print(`  failed jobs: ${jobs.failed}`);
      if (status.cleanup) summarize(print, status.cleanup as Json);
      return;
    }
    case "settings": {
      const repo = repoArg(tail[1]);
      if (tail[0] === "get") return emit(await bot.request("GET", `/repos/${repo}/settings`));
      if (tail[0] !== "set") throw new Error("Usage: ghfind bot settings get|set <owner/repo>");
      const patch: Json = {};
      const map: [string, string][] = [
        ["--issues", "issues_enabled"],
        ["--prs", "prs_enabled"],
        ["--comments-enabled", "comments_enabled"],
        ["--triage", "triage_enabled"],
      ];
      for (const [flag, key] of map) {
        const value = toggle(opts[flag], flag);
        if (value !== undefined) patch[key] = value;
      }
      if (typeof opts["--prompt"] === "string") patch.comment_prompt = opts["--prompt"];
      if (typeof opts["--allowed-labels"] === "string")
        patch.allowed_labels = opts["--allowed-labels"]
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      if (!Object.keys(patch).length) throw new Error("Nothing to set. See: ghfind commands show \"bot settings set\"");
      return emit(await bot.request("PATCH", `/repos/${repo}/settings`, patch));
    }
    case "pause":
    case "resume":
      return emit(await bot.request("POST", `/repos/${repoArg(tail[0])}/${command}`));
    case "backfill": {
      const limit = opts["--limit"] === undefined ? 25 : Number(opts["--limit"]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be 1-100");
      return emit(await bot.request("POST", `/repos/${repoArg(tail[0])}/backfill`, { limit }));
    }
    case "retry":
      return emit(
        await bot.request("POST", `/repos/${repoArg(tail[0])}/retry`, tail[1] ? { job_id: tail[1] } : {}),
      );
    case "cleanup": {
      const sub = tail[0];
      if (sub === "confirm") {
        const repo = repoArg(tail[1]);
        const token = tail[2];
        const id = /^([0-9a-f-]{36})\./.exec(token ?? "")?.[1];
        if (!id) throw new Error("Usage: ghfind bot cleanup confirm <owner/repo> <confirm-token>");
        let view = await bot.request("POST", `/repos/${repo}/cleanups/${id}/confirm`, { token });
        if (opts["--wait"]) view = await bot.waitCleanup(repo, id, ["running"], RUN_WAIT_MS);
        if (json) return emit(view);
        return summarize(print, view);
      }
      if (sub === "status" || sub === "cancel") {
        const repo = repoArg(tail[1]);
        const id = tail[2];
        if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Usage: ghfind bot cleanup ${sub} <owner/repo> <cleanup-id>`);
        const view =
          sub === "status"
            ? await bot.request("GET", `/repos/${repo}/cleanups/${id}`)
            : await bot.request("POST", `/repos/${repo}/cleanups/${id}/cancel`);
        if (json) return emit(view);
        return summarize(print, view);
      }
      const repo = repoArg(sub);
      const labels = String(opts["--labels"] ?? "none");
      const created = await bot.request("POST", `/repos/${repo}/cleanups`, {
        labels,
        comments: Boolean(opts["--comments"]),
        delete_label_definitions: Boolean(opts["--delete-label-definitions"]),
      });
      const token = String(created.confirm_token);
      const id = String((created.cleanup as Json).id);
      const view = opts["--no-wait"]
        ? created
        : await bot.waitCleanup(repo, id, ["planning"], PLAN_WAIT_MS);
      const result = {
        ...view,
        confirm_token: token,
        next: `ghfind bot cleanup confirm ${repo} ${token}`,
      };
      if (json) return emit(result);
      summarize(print, view);
      const state = String(((view.cleanup ?? view) as Json).state);
      if (state === "planned") {
        print("Nothing has been changed. To execute this plan within 10 minutes, run:");
        print(`  ${result.next}`);
      } else if (state === "planning")
        print(`Still previewing. Check with: ghfind bot cleanup status ${repo} ${id}`);
      else print("Nothing has been changed.");
      return;
    }
    default:
      throw new Error("Unknown bot command. Try: ghfind --help");
  }
}
