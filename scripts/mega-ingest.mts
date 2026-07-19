import "./_env.mjs";
import { readFileSync, appendFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { collect } from "../src/lib/github";
import { score, spamBotScore, tierFor } from "../src/lib/score";
import { recordScore, recordProfileSnapshot, updateRoast } from "../src/lib/db";
import type { ScanResult } from "../src/lib/types";
import { buildCtx, buildTags, buildRoastLine, buildRoastReport } from "./roast-gen.mts";

const ORG_DISPLAY: Record<string, string> = {
  langgenius: "Langgenius", "langchain-ai": "LangChain", "run-llama": "LlamaIndex",
  crewaiinc: "CrewAI", "significant-gravitas": "AutoGPT", "n8n-io": "n8n", ollama: "Ollama",
  "chroma-core": "Chroma", qdrant: "Qdrant", "milvus-io": "Milvus", weaviate: "Weaviate",
  berriai: "BerriAI", openbmb: "OpenBMB", infiniflow: "Infiniflow", duckdb: "DuckDB",
  clickhouse: "ClickHouse", prisma: "Prisma", temporalio: "Temporal", dagger: "Dagger",
  hasura: "Hasura", meilisearch: "Meilisearch", sveltejs: "Svelte", tailwindlabs: "Tailwind",
  withastro: "Astro", "oven-sh": "Bun", biomejs: "Biome", trpc: "tRPC", "remix-run": "Remix",
  supabase: "Supabase", appwrite: "Appwrite", directus: "Directus", strapi: "Strapi",
  posthog: "PostHog",
};

const TARGET_ORG_LOGINS = new Set(Object.keys(ORG_DISPLAY));

interface Recon { org: string; count: number; members: string[] }
const recon: Recon[] = JSON.parse(readFileSync("scripts/_org-members.json", "utf8"));
const langgenius: Recon = { org: "langgenius", count: 14, members: [
  "crazywoola","goocarlos","hyoban","laipz8200","lyzno1","RockChinQ","samzong","WH-2099","WTW0313",
  "0xPabloxx","41tair","givemeyourcv","nite-knite","snakevash",
]};
const allOrgs = [...recon, langgenius];

const perOrgCap = Number(process.argv[2]) || 60; // cap members taken per single org (largest orgs)
const usernames: string[] = [];
const seen = new Set<string>();
for (const o of allOrgs) {
  for (const u of o.members.slice(0, perOrgCap)) {
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    usernames.push(u);
  }
}
const testLimit = Number(process.argv[3]) || 0;
const finalUsernames = testLimit > 0 ? usernames.slice(0, testLimit) : usernames;
console.log(`Total unique usernames to process: ${finalUsernames.length} of ${usernames.length} (perOrgCap=${perOrgCap}, testLimit=${testLimit || "none"})`);

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const refresh = process.argv.includes("--refresh");
// Stop after this many NEWLY ingested people (skips don't count). 0 = no cap.
const maxNewArg = process.argv.find((a) => a.startsWith("--max="));
const maxNew = maxNewArg ? Number(maxNewArg.split("=")[1]) || 0 : 0;
if (maxNew > 0) console.log(`Will stop after ${maxNew} newly-ingested people.`);
const logFile = "scripts/_ingest-log.jsonl";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function alreadyDone(username: string): Promise<boolean> {
  if (refresh) return false;
  const r = await db.execute({
    sql: `SELECT roast FROM scores WHERE username = ? AND roast IS NOT NULL AND roast != '' LIMIT 1`,
    args: [username.toLowerCase()],
  });
  return r.rows.length > 0;
}

let ok = 0, skipped = 0, failed = 0;
for (let i = 0; i < finalUsernames.length; i++) {
  if (maxNew > 0 && ok >= maxNew) { console.log(`Reached --max=${maxNew} new ingests, stopping.`); break; }
  const u = finalUsernames[i];
  if (await alreadyDone(u)) { skipped++; console.log(`SKIP ${u} (already has roast)`); continue; }
  if (i > 0) await sleep(1200);
  try {
    const collected = await collect(u);
    const scoring = score(collected.metrics);
    const scan: ScanResult = { ...collected, scoring };
    const { tier } = tierFor(scoring.final_score);

    const realOrgs = collected.organizations ?? [];
    const matchedOrgLogin = realOrgs.find((o) => TARGET_ORG_LOGINS.has(o.toLowerCase()));
    const orgDisplay = matchedOrgLogin ? ORG_DISPLAY[matchedOrgLogin.toLowerCase()] : (realOrgs[0] ?? "");

    const ctx = buildCtx({
      username: collected.metrics.username,
      displayName: collected.metrics.name,
      m: collected.metrics,
      scoring,
      topRepos: collected.top_repos ?? [],
      impactRepos: collected.impact_repos ?? [],
      orgs: realOrgs,
      orgDisplay,
    });
    const tags = buildTags(ctx);
    const roastLine = buildRoastLine(ctx);
    const reportZh = buildRoastReport(ctx, "zh");
    const reportEn = buildRoastReport(ctx, "en");

    await recordScore({
      username: collected.metrics.username,
      display_name: collected.metrics.name,
      avatar_url: collected.metrics.avatar_url,
      profile_url: collected.metrics.profile_url,
      final_score: scoring.final_score,
      tier,
      tags,
      roast_line: roastLine,
      bot_score: spamBotScore(collected.metrics),
      sub_scores: scoring.sub_scores,
      scanned_at: Date.now(),
    });
    await recordProfileSnapshot(scan);
    await updateRoast(collected.metrics.username, reportZh, "zh");
    await updateRoast(collected.metrics.username, reportEn, "en");

    ok++;
    const line = { u: collected.metrics.username, score: scoring.final_score, tier, org: orgDisplay, orgs: realOrgs };
    appendFileSync(logFile, JSON.stringify(line) + "\n");
    console.log(`OK   ${collected.metrics.username.padEnd(20)} score=${String(scoring.final_score).padStart(6)} ${tier.padEnd(6)} org=${orgDisplay}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    appendFileSync(logFile, JSON.stringify({ u, error: msg }) + "\n");
    console.log(`ERR  ${u.padEnd(20)} ${msg}`);
  }
}
console.log(`\nDONE. ok=${ok} skipped=${skipped} failed=${failed} total=${usernames.length}`);
