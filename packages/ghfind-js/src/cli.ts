/**
 * ghfind CLI — a thin command-line wrapper over the {@link GhFind} SDK.
 *
 * Design goals (in priority order):
 *  1. Useful with zero setup: `score` hits the public GET /api/score endpoint,
 *     which needs no auth and is cached + rate-limited on the server.
 *  2. Kind to the ghfind server: `--local` moves the heavy GitHub crawl onto the
 *     caller's own token/machine (see `ghfind/local`); nothing touches ghfind.
 *  3. Drives traffic back: human-facing output ends with a profile link, and
 *     `badge --markdown` prints a README-ready snippet that links to ghfind.com.
 *
 * No LLM is ever bundled. `roast` uses the server's model by default (protected
 * by caching + rate limits); pass `--byo-*` to run it through your own provider.
 */
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { GhFind, GhFindError } from "./client.js";
import type { ByoKey, ScanResult } from "./types.js";
import { catalog, DEFAULT_HOST } from "./catalog.js";

const VERSION: string = "0.1.1";
const DEFAULT_RELEASE_URL = "https://api.github.com/repos/hikariming/ghfind/releases/latest";
const VALID_OUTPUTS = new Set(["json", "pretty", "markdown"]);
const SUB_SCORE_ORDER = [
  "account_maturity",
  "original_project_quality",
  "contribution_quality",
  "ecosystem_impact",
  "community_influence",
  "activity_authenticity",
] as const;

export interface Flags {
  json?: boolean;
  output?: string;
  host?: string;
  apiKey?: string;
  lang?: string;
  view?: string;
  window?: string;
  type?: string;
  value?: string;
  local?: boolean;
  githubToken?: string;
  byoBaseUrl?: string;
  byoApiKey?: string;
  byoModel?: string;
  markdown?: boolean;
  includeScan?: boolean;
  verifyExists?: boolean;
  releaseUrl?: string;
  method?: string;
  target?: string;
  assetUrl?: string;
  dryRun?: boolean;
  help?: boolean;
  version?: boolean;
}

function out(value: string): void {
  process.stdout.write(`${value}\n`);
}
function outJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}
function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  const takesValue: Record<string, keyof Flags> = {
    "-o": "output",
    "--output": "output",
    "--host": "host",
    "--api-key": "apiKey",
    "--lang": "lang",
    "--view": "view",
    "--window": "window",
    "--type": "type",
    "--value": "value",
    "--github-token": "githubToken",
    "--byo-base-url": "byoBaseUrl",
    "--byo-api-key": "byoApiKey",
    "--byo-model": "byoModel",
    "--release-url": "releaseUrl",
    "--method": "method",
    "--target": "target",
    "--asset-url": "assetUrl",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--local") flags.local = true;
    else if (arg === "--markdown" || arg === "--md") flags.markdown = true;
    else if (arg === "--include-scan") flags.includeScan = true;
    else if (arg === "--verify-exists") flags.verifyExists = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "--version") flags.version = true;
    else if (arg in takesValue) {
      const key = takesValue[arg];
      const next = argv[++i];
      if (next === undefined) fail(`${arg} requires a value`);
      (flags as Record<string, unknown>)[key] = next;
    } else positional.push(arg);
  }
  return { positional, flags };
}

function outputMode(flags: Flags, fallback = "pretty"): string {
  const mode = flags.json ? "json" : (flags.output ?? fallback);
  if (!VALID_OUTPUTS.has(mode)) fail(`Invalid output format: ${mode}`);
  return mode;
}

function langMode(flags: Flags): "zh" | "en" {
  const lang = flags.lang ?? "zh";
  if (lang !== "zh" && lang !== "en") fail(`Invalid language: ${lang}`);
  return lang;
}

function client(flags: Flags): GhFind {
  return new GhFind({
    host: flags.host,
    apiKey: flags.apiKey ?? process.env.GHFIND_API_KEY ?? process.env.GITHUB_ROAST_API_KEY,
    githubToken: flags.githubToken ?? process.env.GITHUB_TOKEN,
  });
}

function resolveHost(flags: Flags): string {
  const raw = (
    flags.host ||
    process.env.GHFIND_HOST ||
    process.env.GITHUB_ROAST_HOST ||
    DEFAULT_HOST
  ).trim();
  return raw.replace(/\/+$/, "");
}

export function byoKey(flags: Flags): ByoKey | undefined {
  const baseURL = flags.byoBaseUrl ?? process.env.GHFIND_BYO_BASE_URL;
  const apiKey = flags.byoApiKey ?? process.env.GHFIND_BYO_API_KEY;
  const model = flags.byoModel ?? process.env.GHFIND_BYO_MODEL;
  if (baseURL && apiKey && model) return { baseURL, apiKey, model };
  if (baseURL || apiKey || model) {
    fail("Incomplete BYO key: need --byo-base-url, --byo-api-key and --byo-model together.");
  }
  return undefined;
}

function githubToken(flags: Flags): string | undefined {
  return flags.githubToken ?? process.env.GITHUB_TOKEN;
}

function usernameArg(positional: string[], index = 1): string {
  const username = positional[index];
  if (!username) fail("Missing username.");
  return username;
}

function profileLink(host: string, username: string): string {
  return `\n→ ${host}/u/${encodeURIComponent(username)}`;
}

function printSubScores(subScores: Record<string, number> | undefined): void {
  if (!subScores) return;
  for (const key of SUB_SCORE_ORDER) {
    if (key in subScores) out(`- ${key}: ${subScores[key]}`);
  }
}

async function localScan(flags: Flags, username: string): Promise<ScanResult> {
  const token = githubToken(flags);
  if (!token) {
    fail(
      "--local needs a GitHub token: pass --github-token or set GITHUB_TOKEN.\n" +
        "Local scoring crawls GitHub on your own machine and quota (ghfind is never called).",
    );
  }
  // Loaded lazily so the common remote path never pulls in the heavy engine.
  const { collectAndScore } = await import("./local.js");
  return collectAndScore(username, { token });
}

// ---- commands --------------------------------------------------------------

async function cmdScore(positional: string[], flags: Flags): Promise<void> {
  const username = usernameArg(positional);
  const host = resolveHost(flags);
  const mode = outputMode(flags);

  if (flags.local) {
    const scan = await localScan(flags, username);
    const s = scan.scoring;
    if (mode === "json") {
      outJson({ source: "local", username: scan.metrics.username, ...s });
      return;
    }
    out(`${scan.metrics.username}: ${s.final_score}/100 ${s.tier} (${s.tier_label})`);
    printSubScores(s.sub_scores);
    if (s.red_flags?.length) {
      out("red_flags:");
      for (const f of s.red_flags) out(`- ${f.flag}: -${f.penalty} ${f.detail}`);
    }
    out(profileLink(host, scan.metrics.username));
    return;
  }

  const payload = await client(flags).getScore(username, { verifyExists: flags.verifyExists });
  if (mode === "json") {
    outJson(payload);
    return;
  }
  out(`${payload.username}: ${payload.final_score}/100 ${payload.tier} (${payload.tier_key})`);
  printSubScores(payload.sub_scores);
  if (payload.red_flags?.length) {
    out("red_flags:");
    for (const f of payload.red_flags) out(`- ${f.flag}: -${f.penalty} ${f.detail}`);
  }
  if (payload.percentile?.beat != null) {
    out(`beats ${payload.percentile.beat}% of ${payload.percentile.total} scored accounts`);
  }
  out(profileLink(host, payload.username));
}

async function cmdScan(positional: string[], flags: Flags): Promise<void> {
  const username = usernameArg(positional);
  const scan = flags.local
    ? await localScan(flags, username)
    : await client(flags).scan(username, { verifyExists: flags.verifyExists });
  outJson(scan);
}

async function cmdRoast(positional: string[], flags: Flags): Promise<void> {
  const username = usernameArg(positional);
  const host = resolveHost(flags);
  const lang = langMode(flags);
  const mode = outputMode(flags, "markdown");
  const gh = client(flags);
  // --local crawls + scores on the caller's machine, then sends only the scan to
  // the server for the prose (which still needs a model — the server's or BYO).
  const scan = flags.local ? await localScan(flags, username) : undefined;
  const roast = await gh.roast({ username: scan ? undefined : username, scan, lang, byoKey: byoKey(flags) });

  if (mode === "json") {
    const body: Record<string, unknown> = {
      username,
      lang,
      meta: roast.meta,
      report: roast.report,
    };
    if (flags.includeScan && scan) body.scan = scan;
    outJson(body);
    return;
  }
  if (mode === "markdown") {
    out(roast.report);
    out(profileLink(host, username));
    return;
  }
  out(`${username}: ${roast.meta?.final_score}/100 ${roast.meta?.tier} (${roast.meta?.tier_label})`);
  const line = roast.meta?.roast_line?.[lang] || roast.meta?.roast_line?.zh || roast.meta?.roast_line?.en;
  if (line) out(line);
  out("");
  out(roast.report);
  out(profileLink(host, username));
}

async function cmdVs(positional: string[], flags: Flags): Promise<void> {
  const a = usernameArg(positional, 1);
  const b = usernameArg(positional, 2);
  const host = resolveHost(flags);
  const result = await client(flags).vs(a, b);
  if (outputMode(flags) === "json") {
    outJson(result);
    return;
  }
  if (result.winner) out(`winner: ${result.winner}${result.bucket ? ` (${result.bucket})` : ""}`);
  else out(`result: tie${result.reason ? ` (${result.reason})` : ""}`);
  const verdict = result.verdict?.[flags.lang === "en" ? "en" : "zh"];
  if (verdict) out(verdict);
  out(`\n→ ${host}/vs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
}

async function cmdExists(positional: string[], flags: Flags): Promise<void> {
  const username = usernameArg(positional);
  const user = await client(flags).getGitHubUser(username, { token: githubToken(flags) });
  if (outputMode(flags) === "json") {
    outJson({ username, exists: user !== null, user });
    return;
  }
  out(user ? `${username}: exists` : `${username}: does not exist`);
}

async function cmdSearch(positional: string[], flags: Flags): Promise<void> {
  const q = usernameArg(positional);
  const result = await client(flags).searchUsers(q);
  if (outputMode(flags) === "json") {
    outJson(result);
    return;
  }
  for (const u of result.users ?? []) {
    out(`${u.username}\t${u.final_score}/100 ${u.tier}`);
  }
}

async function cmdLeaderboard(flags: Flags): Promise<void> {
  const view = flags.view as never;
  const window = flags.window as never;
  if (flags.view && !["trending", "score", "heat", "progress"].includes(flags.view)) {
    fail(`Invalid leaderboard view: ${flags.view}`);
  }
  if (flags.window && !["all", "24h", "7d", "30d"].includes(flags.window)) {
    fail(`Invalid leaderboard window: ${flags.window}`);
  }
  const result = await client(flags).leaderboard({ view, window });
  outJson(result);
}

async function cmdDevelopers(flags: Flags): Promise<void> {
  if (!flags.type || !["language", "org", "repo"].includes(flags.type)) {
    fail(`Invalid developers type: ${flags.type ?? ""} (use --type language|org|repo)`);
  }
  const result = await client(flags).developers({ type: flags.type as never, value: flags.value });
  outJson(result);
}

async function cmdStats(flags: Flags): Promise<void> {
  outJson(await client(flags).stats());
}

function cmdBadge(positional: string[], flags: Flags): void {
  const username = usernameArg(positional);
  const gh = client(flags);
  const badge = gh.badgeUrl(username, { lang: flags.lang === "en" ? "en" : undefined });
  const profile = `${resolveHost(flags)}/u/${encodeURIComponent(username)}`;
  if (flags.markdown) {
    out(`[![ghfind score](${badge})](${profile})`);
    return;
  }
  if (outputMode(flags) === "json") {
    outJson({ badge_url: badge, card_url: gh.cardUrl(username), profile });
    return;
  }
  out(badge);
}

function cmdCard(positional: string[], flags: Flags): void {
  const username = usernameArg(positional);
  out(client(flags).cardUrl(username));
}

function cmdCommands(positional: string[], flags: Flags): void {
  if (positional[1] === "show") {
    const name = positional.slice(2).join(" ");
    const cap = catalog.find((c) => c.method === name || c.method.split(" / ").includes(name));
    if (!cap) fail(`Unknown capability: ${name}`);
    outJson(cap);
    return;
  }
  if (flags.json) {
    outJson({ default_host: DEFAULT_HOST, capabilities: catalog });
    return;
  }
  for (const c of catalog) out(`${c.method}\t${c.summary}`);
}

function cmdAuthStatus(flags: Flags): void {
  const apiKey = flags.apiKey ?? process.env.GHFIND_API_KEY ?? process.env.GITHUB_ROAST_API_KEY;
  const body = {
    host: resolveHost(flags),
    default_host: DEFAULT_HOST,
    has_api_key: Boolean(apiKey),
    has_github_token: Boolean(githubToken(flags)),
    has_byo_key: Boolean(byoKeyConfigured(flags)),
    env: {
      primary: ["GHFIND_HOST", "GHFIND_API_KEY", "GITHUB_TOKEN", "GHFIND_BYO_BASE_URL", "GHFIND_BYO_API_KEY", "GHFIND_BYO_MODEL"],
      compatible: ["GITHUB_ROAST_HOST", "GITHUB_ROAST_API_KEY"],
    },
  };
  if (outputMode(flags) === "json") {
    outJson(body);
    return;
  }
  out(`host: ${body.host}`);
  out(`api key: ${body.has_api_key ? "configured" : "missing"}`);
  out(`github token (for --local / exists): ${body.has_github_token ? "configured" : "missing"}`);
  out(`byo llm key (for roast): ${body.has_byo_key ? "configured" : "missing"}`);
}

function byoKeyConfigured(flags: Flags): boolean {
  return Boolean(
    (flags.byoBaseUrl ?? process.env.GHFIND_BYO_BASE_URL) &&
      (flags.byoApiKey ?? process.env.GHFIND_BYO_API_KEY) &&
      (flags.byoModel ?? process.env.GHFIND_BYO_MODEL),
  );
}

function parseVersionParts(version: string | undefined): number[] | null {
  const normalized = String(version ?? "")
    .trim()
    .replace(/^ghfind\s*/i, "")
    .replace(/^v/i, "")
    .split(/[+-]/)[0];
  if (!normalized || normalized === "dev") return null;
  const parts = normalized.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts;
}

function isNewerVersion(latest: string | undefined, current: string): { newer: boolean; comparable: boolean } {
  const latestParts = parseVersionParts(latest);
  const currentParts = parseVersionParts(current);
  if (!latestParts || !currentParts) return { newer: false, comparable: false };
  const max = Math.max(latestParts.length, currentParts.length);
  for (let i = 0; i < max; i++) {
    const l = latestParts[i] ?? 0;
    const c = currentParts[i] ?? 0;
    if (l > c) return { newer: true, comparable: true };
    if (l < c) return { newer: false, comparable: true };
  }
  return { newer: false, comparable: true };
}

async function checkUpdate(flags: Flags): Promise<Record<string, unknown>> {
  const releaseUrl = flags.releaseUrl ?? process.env.GHFIND_RELEASE_URL ?? DEFAULT_RELEASE_URL;
  const response = await fetch(releaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ghfind-cli",
    },
  });
  if (response.status === 404) {
    return {
      name: "ghfind",
      current_version: VERSION,
      update_available: false,
      checked_url: releaseUrl,
      status: "no_release",
      message: "No GitHub release is published yet.",
    };
  }
  if (!response.ok) throw new GhFindError(`API request failed with HTTP ${response.status}`, { status: response.status });
  const latest = (await response.json()) as { tag_name?: string; html_url?: string };
  const comparison = isNewerVersion(latest.tag_name, VERSION);
  let status = "current";
  let message = "ghfind is up to date.";
  if (VERSION === "dev") {
    status = "dev_build";
    message = "This is a dev build; compare manually with the latest release.";
  } else if (!comparison.comparable) {
    status = "unknown";
    message = "Could not compare versions; compare manually with the latest release.";
  } else if (comparison.newer) {
    status = "update_available";
    message = "A newer ghfind CLI release is available.";
  }
  return {
    name: "ghfind",
    current_version: VERSION,
    latest_version: latest.tag_name ?? "",
    update_available: comparison.newer && comparison.comparable,
    release_url: latest.html_url ?? "",
    checked_url: releaseUrl,
    status,
    message,
  };
}

function releaseAssetName(): string {
  const goos = platform() === "win32" ? "windows" : platform();
  const goarch = arch() === "x64" ? "amd64" : arch();
  return `ghfind-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`;
}

async function fetchLatestRelease(flags: Flags): Promise<{ release: Record<string, unknown>; checkedUrl: string }> {
  const releaseUrl = flags.releaseUrl ?? process.env.GHFIND_RELEASE_URL ?? DEFAULT_RELEASE_URL;
  const response = await fetch(releaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ghfind-cli",
    },
  });
  if (!response.ok) throw new GhFindError(`API request failed with HTTP ${response.status}`, { status: response.status });
  return { release: (await response.json()) as Record<string, unknown>, checkedUrl: releaseUrl };
}

function selectReleaseAsset(release: Record<string, unknown>, assetUrl: string | undefined): { name: string; url: string } {
  if (assetUrl) return { name: "custom", url: assetUrl };
  const want = releaseAssetName();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((item): item is { name: string; browser_download_url: string } => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    return candidate.name === want && typeof candidate.browser_download_url === "string";
  });
  if (!asset) fail(`Release ${String(release.tag_name ?? "")} does not contain asset ${want}`);
  return { name: asset.name, url: asset.browser_download_url };
}

async function installBinaryUpdate(flags: Flags): Promise<Record<string, unknown>> {
  if (platform() === "win32") {
    fail("Binary self-update is not supported on Windows; use --method npm, pip, or brew.");
  }
  const { release, checkedUrl } = await fetchLatestRelease(flags);
  const asset = selectReleaseAsset(release, flags.assetUrl);
  const target = resolve(flags.target ?? process.argv[1] ?? "ghfind");
  const latestVersion = String(release.tag_name ?? "");
  const comparison = isNewerVersion(latestVersion, VERSION);
  let status = "current";
  let message = "ghfind is already up to date.";
  if (VERSION === "dev" || !comparison.comparable) {
    status = "installable";
    message = "Current version is not comparable; installing the latest release asset is allowed.";
  } else if (comparison.newer) {
    status = "update_available";
    message = "A newer ghfind CLI release is available.";
  }
  const result: Record<string, unknown> = {
    name: "ghfind",
    current_version: VERSION,
    latest_version: latestVersion,
    update_available: comparison.newer && comparison.comparable,
    method: "binary",
    target_path: target,
    asset_name: asset.name,
    asset_url: asset.url,
    release_url: String(release.html_url ?? ""),
    checked_url: checkedUrl,
    status,
    message,
    ...(flags.dryRun ? { dry_run: true } : {}),
  };
  if (flags.dryRun) {
    result.status = "dry_run";
    result.message = "Dry run only; no files were changed.";
    return result;
  }
  if (status === "current") return result;

  const download = await fetch(asset.url, { headers: { "user-agent": "ghfind-cli" } });
  if (!download.ok) throw new GhFindError(`API request failed with HTTP ${download.status}`, { status: download.status });
  const mode = statSync(target).mode;
  const tmp = `${target}.new`;
  const backup = `${target}.old`;
  writeFileSync(tmp, Buffer.from(await download.arrayBuffer()), { mode });
  chmodSync(tmp, mode);
  rmSync(backup, { force: true });
  renameSync(target, backup);
  try {
    renameSync(tmp, target);
  } catch (error) {
    renameSync(backup, target);
    rmSync(tmp, { force: true });
    throw error;
  }
  rmSync(backup, { force: true });
  result.status = "updated";
  result.message = "ghfind binary was updated.";
  return result;
}

function packageManagerCommand(method: string): string[] {
  if (method === "npm") return ["npm", "install", "-g", "@hikariming/ghfind@latest"];
  if (method === "pip") return ["python3", "-m", "pip", "install", "--upgrade", "ghfind"];
  if (method === "brew") return ["brew", "upgrade", "ghfind"];
  fail(`Invalid update method: ${method}`);
}

function installPackageManagerUpdate(method: string, flags: Flags): Record<string, unknown> {
  const command = packageManagerCommand(method);
  const result: Record<string, unknown> = {
    name: "ghfind",
    current_version: VERSION,
    method,
    command,
    status: flags.dryRun ? "dry_run" : "ready",
    message: flags.dryRun ? "Dry run only; command was not executed." : "Package manager upgrade is ready.",
    ...(flags.dryRun ? { dry_run: true } : {}),
  };
  if (flags.dryRun) return result;
  const child = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
  if (child.status !== 0) {
    fail(`${method} failed: ${(child.stderr || child.stdout || "").trim()}`);
  }
  result.status = "updated";
  result.message = "Package manager upgrade completed.";
  return result;
}

async function installUpdate(method: string | undefined, flags: Flags): Promise<Record<string, unknown>> {
  const resolvedMethod = method || flags.method || "binary";
  if (resolvedMethod === "binary") return installBinaryUpdate(flags);
  return installPackageManagerUpdate(resolvedMethod, flags);
}

function printUpdateInfo(info: Record<string, unknown>, mode: string): void {
  if (mode === "json") return outJson(info);
  out(`ghfind current: ${info.current_version}`);
  if (info.latest_version) out(`latest: ${info.latest_version}`);
  out(`status: ${info.status}`);
  out(String(info.message));
  if (info.release_url) out(`release: ${info.release_url}`);
}

function printUpdateInstallResult(result: Record<string, unknown>, mode: string): void {
  if (mode === "json") return outJson(result);
  out(`ghfind update method: ${result.method}`);
  out(`current: ${result.current_version}`);
  if (result.latest_version) out(`latest: ${result.latest_version}`);
  out(`status: ${result.status}`);
  out(String(result.message));
  if (result.target_path) out(`target: ${result.target_path}`);
  if (result.asset_url) out(`asset: ${result.asset_url}`);
  if (Array.isArray(result.command)) out(`command: ${result.command.join(" ")}`);
}

function printHelp(): void {
  out("ghfind — score any GitHub account 0-100 (deterministic, no LLM) + roasts, battles, leaderboards.");
  out("");
  out("Usage: ghfind <command> [options]");
  out("");
  out("Commands:");
  out("  score <user>          Deterministic score via GET /api/score (no auth, cached). --local to score offline.");
  out("  scan <user>           Full evidence payload via POST /api/scan (heavy; needs --api-key in prod). --local supported.");
  out("  roast <user>          Human-facing roast report (LLM). --byo-* to use your own model.");
  out("  vs <a> <b>            Head-to-head verdict (winner deterministic).");
  out("  exists <user>         Check a GitHub login exists (client-side; never touches ghfind).");
  out("  search <query>        Prefix autocomplete over scored accounts.");
  out("  leaderboard           Ranked profiles. --view trending|score|heat|progress --window all|24h|7d|30d");
  out("  developers --type T   Discover developers by language|org|repo [--value V].");
  out("  stats                 Platform totals.");
  out("  badge <user>          Print the score badge URL. --markdown for a README snippet.");
  out("  card <user>           Print the OG share-card URL.");
  out("  update check          Check whether this ghfind CLI is older than the latest release.");
  out("  update install        Install latest release binary, or --method npm|pip|brew.");
  out("  update npm|pip|brew   Upgrade through a package manager. Use --dry-run first.");
  out("  commands [show <c>]    List agent-callable capabilities (self-describing).");
  out("  auth status           Show host + which credentials are configured.");
  out("");
  out("Common options: --host, --api-key, --json, -o/--output, --lang zh|en");
  out("Local scoring:  --local (score/scan/roast) uses your GITHUB_TOKEN, entirely on your machine.");
  out("Bring your own model: --byo-base-url --byo-api-key --byo-model (roast only).");
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (flags.version || command === "version") {
    out(`ghfind ${VERSION}`);
    return;
  }
  if (!command || flags.help) {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "score":
        return await cmdScore(positional, flags);
      case "scan":
        return await cmdScan(positional, flags);
      case "roast":
        return await cmdRoast(positional, flags);
      case "vs":
        return await cmdVs(positional, flags);
      case "exists":
        return await cmdExists(positional, flags);
      case "search":
        return await cmdSearch(positional, flags);
      case "leaderboard":
        return await cmdLeaderboard(flags);
      case "developers":
        return await cmdDevelopers(flags);
      case "stats":
        return await cmdStats(flags);
      case "badge":
        return cmdBadge(positional, flags);
      case "card":
        return cmdCard(positional, flags);
      case "update":
        if (positional[1] === "check") return printUpdateInfo(await checkUpdate(flags), outputMode(flags));
        if (positional[1] === "install") {
          return printUpdateInstallResult(await installUpdate(undefined, flags), outputMode(flags));
        }
        if (["npm", "pip", "brew"].includes(positional[1])) {
          return printUpdateInstallResult(await installUpdate(positional[1], flags), outputMode(flags));
        }
        return fail("Unknown update command. Try: ghfind update check");
      case "commands":
        return cmdCommands(positional, flags);
      case "auth":
        if (positional[1] === "status") return cmdAuthStatus(flags);
        return fail("Unknown auth command. Try: ghfind auth status");
      default:
        return fail(`Unknown command: ${command}. Run 'ghfind --help'.`);
    }
  } catch (e) {
    if (e instanceof GhFindError) {
      const suffix = e.code ? ` (${e.code})` : "";
      fail(`${e.message}${suffix}`, e.status === 429 ? 2 : 1);
    }
    if (e instanceof Error) fail(e.message);
    throw e;
  }
}
