#!/usr/bin/env node
import { DEFAULT_HOST, commandCatalog, findCommand } from "./catalog.mjs";
import { CliHttpError, normalizeHost, roastAccount, scanAccount } from "./remote-client.mjs";

const VALID_OUTPUTS = new Set(["json", "pretty", "markdown"]);
const VALID_LANGS = new Set(["zh", "en"]);

function print(value) {
  process.stdout.write(`${value}\n`);
}

function printJson(value) {
  print(JSON.stringify(value, null, 2));
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      flags.output = argv[++i];
      continue;
    }
    if (arg === "--host") {
      flags.host = argv[++i];
      continue;
    }
    if (arg === "--api-key") {
      flags.apiKey = argv[++i];
      continue;
    }
    if (arg === "--turnstile-token") {
      flags.turnstileToken = argv[++i];
      continue;
    }
    if (arg === "--lang") {
      flags.lang = argv[++i];
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function baseOptions(flags) {
  return {
    host: normalizeHost(flags.host),
    apiKey: flags.apiKey ?? process.env.GITHUB_ROAST_API_KEY,
    turnstileToken: flags.turnstileToken ?? process.env.GITHUB_ROAST_TURNSTILE_TOKEN,
    fetchImpl: fetch,
  };
}

function outputMode(flags, fallback = "pretty") {
  const mode = flags.json ? "json" : (flags.output ?? fallback);
  if (!VALID_OUTPUTS.has(mode)) fail(`Invalid output format: ${mode}`);
  return mode;
}

function langMode(flags) {
  const lang = flags.lang ?? "zh";
  if (!VALID_LANGS.has(lang)) fail(`Invalid language: ${lang}`);
  return lang;
}

function usernameArg(positional, index = 1) {
  const username = positional[index];
  if (!username) fail("Missing username.");
  return username;
}

function scoreSummary(scan) {
  return {
    username: scan.metrics?.username,
    final_score: scan.scoring?.final_score,
    tier: scan.scoring?.tier,
    tier_label: scan.scoring?.tier_label,
    sub_scores: scan.scoring?.sub_scores,
    red_flags: scan.scoring?.red_flags ?? [],
    cached: scan.cached ?? false,
  };
}

function roastSummary(scan, roast, lang) {
  return {
    username: scan.metrics?.username,
    lang,
    final_score: roast.meta?.final_score,
    tier: roast.meta?.tier,
    tier_label: roast.meta?.tier_label,
    delta: roast.meta?.delta,
    percentile: roast.meta?.percentile ?? null,
    tags: roast.meta?.tags ?? { zh: [], en: [] },
    roast_line: roast.meta?.roast_line ?? { zh: "", en: "" },
    report: roast.report,
    scan,
  };
}

function printScore(summary, mode) {
  if (mode === "json") return printJson(summary);
  print(`${summary.username}: ${summary.final_score}/100 ${summary.tier} (${summary.tier_label})`);
  for (const [key, value] of Object.entries(summary.sub_scores ?? {})) {
    print(`- ${key}: ${value}`);
  }
  if (summary.red_flags.length > 0) {
    print("red_flags:");
    for (const flag of summary.red_flags) print(`- ${flag.flag}: -${flag.penalty} ${flag.detail}`);
  }
}

function printRoast(summary, mode) {
  if (mode === "json") return printJson(summary);
  if (mode === "markdown") return print(summary.report);
  print(`${summary.username}: ${summary.final_score}/100 ${summary.tier} (${summary.tier_label})`);
  const line = summary.roast_line?.[summary.lang] || summary.roast_line?.zh || summary.roast_line?.en;
  if (line) print(line);
  print("");
  print(summary.report);
}

function printCatalog(json) {
  if (json) return printJson({ default_host: DEFAULT_HOST, commands: commandCatalog });
  for (const cmd of commandCatalog) {
    print(`${cmd.name}\t${cmd.summary}`);
  }
}

function printCommand(name, json) {
  const cmd = findCommand(name);
  if (!cmd) fail(`Unknown command: ${name}`);
  if (json) return printJson(cmd);
  print(`${cmd.name}`);
  print(`usage: ${cmd.usage}`);
  print(cmd.summary);
  print(`api: ${cmd.api.length ? cmd.api.join(", ") : "none"}`);
  print(`auth: ${cmd.auth}`);
  print(`outputs: ${cmd.output.join(", ")}`);
}

function printAuthStatus(flags) {
  const options = baseOptions(flags);
  const body = {
    host: options.host,
    default_host: DEFAULT_HOST,
    has_api_key: Boolean(options.apiKey),
    has_turnstile_token: Boolean(options.turnstileToken),
  };
  if (outputMode(flags) === "json") return printJson(body);
  print(`host: ${body.host}`);
  print(`api key: ${body.has_api_key ? "configured" : "missing"}`);
  print(`turnstile token: ${body.has_turnstile_token ? "configured" : "missing"}`);
}

function printHelp() {
  print("github-roast CLI");
  print("");
  print("Remote CLI for the ghfind.com GitHub Roast website APIs.");
  print("");
  print("Commands:");
  printCatalog(false);
  print("");
  print("Common options: --host, --api-key, --turnstile-token, -o/--output");
}

export async function run(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  if (!command || flags.help) return printHelp();

  try {
    if (command === "commands") {
      if (positional[1] === "show") return printCommand(positional[2], flags.json);
      return printCatalog(flags.json);
    }
    if (command === "auth" && positional[1] === "status") return printAuthStatus(flags);

    if (command === "scan") {
      const result = await scanAccount({
        ...baseOptions(flags),
        username: usernameArg(positional),
      });
      return outputMode(flags) === "json" ? printJson(result) : printJson(result);
    }

    if (command === "score") {
      const scan = await scanAccount({
        ...baseOptions(flags),
        username: usernameArg(positional),
      });
      return printScore(scoreSummary(scan), outputMode(flags));
    }

    if (command === "roast") {
      const lang = langMode(flags);
      const scan = await scanAccount({
        ...baseOptions(flags),
        username: usernameArg(positional),
      });
      const roast = await roastAccount({
        ...baseOptions(flags),
        scan,
        lang,
      });
      return printRoast(roastSummary(scan, roast, lang), outputMode(flags, "markdown"));
    }

    fail(`Unknown command: ${command}`);
  } catch (e) {
    if (e instanceof CliHttpError) {
      const suffix = e.code ? ` (${e.code})` : "";
      fail(`${e.message}${suffix}`, e.status === 429 ? 2 : 1);
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
