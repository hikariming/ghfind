import "./_env.mjs";
import { createClient } from "@libsql/client";

const ORG = "langgenius";
const token = process.env.GITHUB_TOKEN!;
const gh = async (url: string) => {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gh-roast-audit",
    },
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return r;
};

// 1) Public org members (paginated)
const members: string[] = [];
for (let page = 1; ; page++) {
  const r = await gh(`https://api.github.com/orgs/${ORG}/members?per_page=100&page=${page}`);
  const arr = (await r.json()) as { login: string }[];
  members.push(...arr.map((m) => m.login));
  if (arr.length < 100) break;
}
console.log(`GitHub public members of ${ORG}: ${members.length}`);

// 2) DB current state
const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const facetRows = await db.execute({
  sql: `SELECT f.username, s.final_score, s.hidden
        FROM developer_facets f LEFT JOIN scores s ON s.username=f.username
        WHERE f.facet_type='org' AND f.facet_value=?`,
  args: [ORG],
});
const inFacet = new Map(facetRows.rows.map((r) => [String(r.username), r]));

// which members already have a score row at all
const lower = members.map((m) => m.toLowerCase());
const placeholders = lower.map(() => "?").join(",");
const scoreRows = lower.length
  ? await db.execute({
      sql: `SELECT username, final_score, hidden FROM scores WHERE username IN (${placeholders})`,
      args: lower,
    })
  : { rows: [] as Record<string, unknown>[] };
const scored = new Map(scoreRows.rows.map((r) => [String(r.username), r]));

const missing: string[] = [];
const belowFloor: string[] = [];
const ok: string[] = [];
for (const m of members) {
  const s = scored.get(m.toLowerCase());
  if (!s) missing.push(m);
  else if (Number(s.final_score) < 60 || Number(s.hidden) === 1) belowFloor.push(`${m}(${s.final_score}${Number(s.hidden)?",hidden":""})`);
  else ok.push(`${m}(${s.final_score})`);
}

console.log(`\n== org facet '${ORG}' rows in DB: ${inFacet.size} ==`);
console.log(`\n[shown in directory, score>=60] ${ok.length}:`);
console.log(ok.join(", ") || "(none)");
console.log(`\n[in DB but below floor / hidden] ${belowFloor.length}:`);
console.log(belowFloor.join(", ") || "(none)");
console.log(`\n[NOT in DB at all] ${missing.length}:`);
console.log(missing.join(", ") || "(none)");
