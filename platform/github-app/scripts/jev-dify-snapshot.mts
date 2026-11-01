import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

// Public GET requests only. No GitHub credential, mutations, or model calls.
// The public bodies live only in this external reproducibility snapshot, never
// in application D1 or diagnostic logs. Expectations precede any Jev execution.
const output = resolve(
  process.env.JEV_SNAPSHOT_OUTPUT || "tmp/saas-jev-live/dify-snapshot.json",
);
const base = "https://api.github.com/repos/langgenius/dify";
async function get(path: string) {
  const response = await fetch(base + path, {
    method: "GET",
    headers: {
      "User-Agent": "ghfind-local-readonly-evaluation",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Public GitHub snapshot unavailable: HTTP ${response.status}`,
    );
  return response.json();
}
const allLabels: { name: string; description: string | null }[] = await get(
  "/labels?per_page=100&page=1",
);
if (!Array.isArray(allLabels) || allLabels.length === 100)
  throw new Error("Unexpected label snapshot pagination");
const groupNames = [
  ["🐞 bug", "💪 enhancement", "📚 documentation", "🙋‍♂️ question"],
  ["🌊 feat:workflow", "👻 feat:rag", "🤖 feat:agent", "🔨 feat:tools"],
];
const groups = groupNames.map((names) =>
  names.map((name) => {
    const label = allLabels.find((value) => value.name === name);
    if (!label || !label.description?.trim())
      throw new Error("Required described Dify label missing");
    return { name, description: label.description };
  }),
);
const samples = [
  { number: 43536, pr: false, expected: [["🐞 bug"], ["👻 feat:rag"]] },
  { number: 43600, pr: false, expected: [["🐞 bug"], ["🤖 feat:agent"]] },
  { number: 43617, pr: true, expected: [["🐞 bug"], ["🌊 feat:workflow"]] },
  {
    number: 43613,
    pr: true,
    expected: [["💪 enhancement", "📚 documentation"], []],
  },
];
const fixtures = [];
for (const sample of samples) {
  const source = await get(`/issues/${sample.number}`);
  if (
    typeof source.title !== "string" ||
    typeof source.body !== "string" ||
    !!source.pull_request !== sample.pr ||
    source.body.length > 8000
  )
    throw new Error("Unexpected public item snapshot");
  for (let group = 0; group < groups.length; group++)
    fixtures.push({
      id: `dify-${sample.pr ? "pr" : "issue"}-${sample.number}-group-${group + 1}`,
      title: source.title,
      body: source.body,
      pr: sample.pr,
      number: sample.number,
      sourceUrl: source.html_url,
      sourceUpdatedAt: source.updated_at,
      repository: group === 0 ? 701 : 902,
      fullName:
        group === 0
          ? "synthetic-alpha/dify-intents"
          : "synthetic-beta/dify-areas",
      definitions: allLabels.map((label) => ({
        name: label.name,
        description: label.description || "",
      })),
      allowed: groupNames[group],
      expected: sample.expected[group],
    });
}
mkdirSync(dirname(output), { recursive: true });
const snapshot =
  JSON.stringify(
    {
      at: new Date().toISOString(),
      repository: "langgenius/dify",
      policy:
        "Public GET-only snapshot. Local repository/group scopes are synthetic; no online labels or settings changed.",
      groups,
      fixtures,
    },
    null,
    2,
  ) + "\n";
writeFileSync(output, snapshot, { mode: 0o600 });
console.log(
  JSON.stringify({
    snapshot: output,
    sha256: createHash("sha256").update(snapshot).digest("hex"),
    publicGetCount: 5,
    fixtures: fixtures.length,
    sources: samples.map(({ number, pr }) => ({
      number,
      kind: pr ? "pull_request" : "issue",
    })),
    labelGroups: groups,
  }),
);
