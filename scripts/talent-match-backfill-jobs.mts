/**
 * Extract structured requirements (job_requirements) for open hiring-board jobs
 * whose copy changed since their last extraction, for Talent Match.
 *
 * Normally unnecessary: the ghfind-talent Worker's JobSyncWorkflow does this
 * daily in production (and on demand with `wrangler workflows trigger`). This
 * script is the offline fallback, for reviewing the extraction as SQL first.
 *
 * Reads the job copy from remote D1 (read-only `wrangler d1 execute --json`),
 * runs LLM #1 locally with the operator's keys from .env (LLM_* or
 * TALENT_LLM_*), and — like the other D1 backfills — only emits reviewable
 * SQL. A human applies it:
 *
 *   node --import tsx scripts/talent-match-backfill-jobs.mts [--env dev|production] [--all]
 *   pnpm exec wrangler d1 execute ghfind --remote --file scripts/talent-match/out/job-requirements.sql
 *
 * Jobs are skipped when their stored input_hash matches the current copy;
 * --all re-extracts every open job. Unknown skill names are reported so the
 * taxonomy (src/lib/talent-match/taxonomy.ts) can grow. Dev and production
 * share the core database, so --env only picks wrangler's config section.
 */
import "./_env.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Client, InStatement } from "@libsql/client";
import { extractRequirement, llmCompleter } from "../src/lib/talent-match/extract";
import { jobInputHash, talentLlmConfigs } from "../src/lib/talent-match/pipeline";
import { SCHEMA_VERSION } from "../src/lib/talent-match/schema";
import { listJobSources } from "../src/lib/talent-match/store";

const OUT_DIR = new URL("./talent-match/out/", import.meta.url);
const OUT_SQL = new URL("job-requirements.sql", OUT_DIR);
// The repo's own wrangler, so the script works without pnpm on PATH.
const WRANGLER = new URL("../node_modules/.bin/wrangler", import.meta.url).pathname;

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const env = envIndex >= 0 ? args[envIndex + 1] : "production";
if (env !== "dev" && env !== "production") throw new Error("--env must be dev or production");
const all = args.includes("--all");

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Read-only libSQL-shaped client over `wrangler d1 execute --remote --json`. */
function wranglerClient(): Client {
  const execute = async (stmt: InStatement) => {
    const { sql, args: values } = typeof stmt === "string" ? { sql: stmt, args: [] } : stmt;
    const list = Array.isArray(values) ? values : [];
    let i = 0;
    const inlined = sql.replace(/\?/g, () => sqlLiteral(list[i++]));
    if (!/^\s*SELECT\b/i.test(inlined)) throw new Error("wranglerClient is read-only");
    const out = execFileSync(
      WRANGLER,
      ["d1", "execute", "ghfind", "--remote", "--json", "--env", env, "--command", inlined],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const [result] = JSON.parse(out) as { results: Record<string, unknown>[] }[];
    return { rows: result.results, rowsAffected: 0 };
  };
  return { execute } as unknown as Client;
}

async function main() {
  const configs = talentLlmConfigs();
  if (!configs.length) throw new Error("No LLM configured: set LLM_API_KEY (or TALENT_LLM_*) in .env");
  const complete = llmCompleter(configs);
  const now = Date.now();
  const sources = await listJobSources(wranglerClient(), now);

  const statements: string[] = [];
  const unknown = new Map<string, number>();
  let skipped = 0;
  let failed = 0;
  for (const job of sources) {
    const inputHash = jobInputHash(job.text);
    if (!all && job.storedHash === inputHash) {
      skipped++;
      continue;
    }
    try {
      const { requirement, unknownSkills } = await extractRequirement(complete, job.text);
      for (const name of unknownSkills) unknown.set(name, (unknown.get(name) ?? 0) + 1);
      statements.push(
        `INSERT INTO job_requirements (id, job_id, requirement_json, input_hash, vector_id, schema_version, updated_at)
VALUES (${[job.id, job.id, JSON.stringify(requirement), inputHash, null, SCHEMA_VERSION, now].map(sqlLiteral).join(", ")})
ON CONFLICT(id) DO UPDATE SET requirement_json = excluded.requirement_json, input_hash = excluded.input_hash,
  vector_id = excluded.vector_id, schema_version = excluded.schema_version, updated_at = excluded.updated_at;`,
      );
      console.log(`extracted ${job.id}: ${requirement.mustHave.length} must-have, ${requirement.niceToHave.length} nice-to-have`);
    } catch (error) {
      // A rejected key or exhausted quota fails every job the same way: stop.
      // (Matched by status: the script and src/lib can load separate copies of llm.ts.)
      const status = (error as { status?: unknown }).status;
      if (status === 401 || status === 402 || status === 429) {
        throw new Error(`LLM provider rejected the request (${status}): check the keys in .env`);
      }
      failed++;
      console.error(`failed ${job.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_SQL, statements.join("\n\n") + "\n");
  console.log(`\n${statements.length} extracted, ${skipped} unchanged, ${failed} failed → ${OUT_SQL.pathname}`);
  if (unknown.size) {
    console.log("Unknown skill names (consider adding to the taxonomy):");
    for (const [name, n] of [...unknown].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${name}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
