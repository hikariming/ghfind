import "./_env.mjs";
import { collect } from "../src/lib/github";
import { score } from "../src/lib/score";
import type { ScanResult } from "../src/lib/types";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3001";
const users = (process.env.SMOKE_USERS ?? "torvalds,gaearon,yyx990803,sindresorhus,karpathy")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const query = process.env.SMOKE_QUERY ?? "我想关注做 AI Agent、前端工程化和开源工具的开发者";

function requireEnv(name: string) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function buildScan(username: string): Promise<ScanResult> {
  const {
    metrics,
    top_repos,
    recent_prs,
    flood_pr_titles,
    impact_repos,
    verified_impact_prs,
    pinned_repos,
    organizations,
  } = await collect(username);
  return {
    metrics,
    top_repos,
    recent_prs,
    flood_pr_titles,
    impact_repos,
    verified_impact_prs,
    pinned_repos,
    organizations,
    scoring: score(metrics),
  };
}

async function main() {
  requireEnv("GITHUB_TOKEN");
  requireEnv("TURSO_DATABASE_URL");
  if (!process.env.LLM_API_KEY && !process.env.OPENROUTER_API_KEY) {
    throw new Error("LLM_API_KEY or OPENROUTER_API_KEY is required");
  }

  console.log(`baseUrl=${baseUrl}`);
  console.log(`users=${users.join(", ")}`);

  for (const username of users) {
    console.log(`\nscan ${username}`);
    const scan = await buildScan(username);
    console.log(
      `score=${scan.scoring.final_score.toFixed(2)} repos=${scan.top_repos.length} impact=${scan.impact_repos.length}`,
    );
    const roastRes = await fetch(`${baseUrl}/api/roast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan, lang: "zh" }),
    });
    const roastText = await roastRes.text();
    if (!roastRes.ok) {
      throw new Error(`/api/roast ${roastRes.status}: ${roastText.slice(0, 500)}`);
    }
    console.log(`roast=ok chars=${roastText.length}`);
  }

  for (const type of ["language", "repo", "org"] as const) {
    const res = await fetch(`${baseUrl}/api/developers?type=${type}`);
    const data = (await res.json()) as { categories?: { value: string; count: number }[] };
    console.log(
      `\n${type} facets:`,
      (data.categories ?? []).slice(0, 12).map((c) => `${c.value}(${c.count})`).join(", "),
    );
  }

  const search = await postJson<{
    mode: string;
    error?: string;
    summary?: string;
    facets: { type: string; value: string; count: number }[];
    developers: { username: string; final_score: number; matched_facets: unknown[] }[];
  }>("/api/developers/search", { query, lang: "zh" });
  console.log(`\nAI search mode=${search.mode} error=${search.error ?? ""}`);
  console.log(`summary=${search.summary ?? ""}`);
  console.log(
    "facets=",
    search.facets.map((f) => `${f.type}:${f.value}(${f.count})`).join(", "),
  );
  console.log(
    "developers=",
    search.developers
      .slice(0, 10)
      .map((d) => `${d.username}:${d.final_score.toFixed(2)}[${d.matched_facets.length}]`)
      .join(", "),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
