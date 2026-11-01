import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { triage } from "../src/triage.ts";
import { runIntentPreview } from "../src/intent-preview.ts";
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_THRESHOLD,
  JEV_REQUEST_VERSION,
} from "../src/jev.ts";
import {
  fixtures,
  heldoutFixtures,
  heldoutExtraFixtures,
  semanticGroupFixtures,
  labels,
  type Fixture,
} from "./jev-fixtures.ts";

// Run from the repository root: pnpm exec tsx platform/github-app/scripts/jev-live.mts
// Key is read in process, never an argv value. Outputs contain synthetic identifiers,
// probabilities, latency and billing metadata only; never requests, headers or bodies.
const credentialPath =
  process.env.JEV_CREDENTIAL_FILE ||
  `${process.env.HOME}/.config/ghfind/.env.openrouter`;
const match = readFileSync(credentialPath, "utf8").match(
  /^OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/m,
);
const key = match?.[1].replace(/^(["'])(.*)\1$/, "$2");
if (!key) throw new Error("Missing local OpenRouter credential");
const out = resolve(process.env.JEV_EVAL_OUTPUT || "tmp/saas-jev-live");
mkdirSync(out, { recursive: true });
const suite = process.env.JEV_EVAL_SUITE || "development";
if (
  ![
    "development",
    "holdout",
    "holdout-extra",
    "semantic-groups",
    "dify-snapshot",
  ].includes(suite)
)
  throw new Error("Unknown evaluation suite");
const snapshotPath = process.env.JEV_EVAL_FIXTURES;
if (suite === "dify-snapshot" && !snapshotPath)
  throw new Error("Missing public snapshot file");
const cases: Fixture[] =
  suite === "dify-snapshot"
    ? JSON.parse(readFileSync(snapshotPath!, "utf8")).fixtures
    : suite === "semantic-groups"
      ? semanticGroupFixtures
      : suite === "holdout-extra"
        ? heldoutExtraFixtures
        : suite === "holdout"
          ? heldoutFixtures
          : fixtures;
const requestVersion = JEV_REQUEST_VERSION;
const classifierSourceSha256 = createHash("sha256")
  .update(readFileSync(new URL("../src/jev.ts", import.meta.url)))
  .update(readFileSync(new URL("../src/triage.ts", import.meta.url)))
  .digest("hex");
const fixtureSha256 = createHash("sha256")
  .update(
    readFileSync(
      suite === "dify-snapshot"
        ? snapshotPath!
        : new URL("./jev-fixtures.ts", import.meta.url),
    ),
  )
  .digest("hex");
const realFetch = globalThis.fetch;
let expectedDefinitions: { name: string; description: string }[] = [];
let observed: {
  model?: unknown;
  answers?: unknown;
  usage?: unknown;
  responseHttpStatus?: number;
  requestSha256?: string;
  calls: number;
} = { calls: 0 };
globalThis.fetch = async (input, init) => {
  if (String(input) !== JEV_ENDPOINT)
    throw new Error("Unexpected live eval network endpoint");
  const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  if (
    Object.keys(request.questions || {}).length !==
      expectedDefinitions.length ||
    expectedDefinitions.some(
      (label, index) =>
        request.questions?.[`label_${index}`]?.criteria?.true !==
        (label.description.trim() || label.name),
    )
  )
    throw new Error("Cross-repository or stale definition in decision request");
  observed.calls++;
  observed.requestSha256 = createHash("sha256")
    .update(typeof init?.body === "string" ? init.body : "")
    .digest("hex");
  const response = await realFetch(input, init);
  observed.responseHttpStatus = response.status;
  if (response.ok) {
    const raw = (await response.clone().json()) as Record<string, unknown>;
    const numeric = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const answers =
      raw.answers && typeof raw.answers === "object"
        ? Object.fromEntries(
            Object.entries(raw.answers)
              .filter(([id]) => /^label_\d+$/.test(id))
              .map(([id, value]) => [
                id,
                {
                  noul: numeric(
                    value && typeof value === "object"
                      ? (value as Record<string, unknown>).noul
                      : undefined,
                  ),
                },
              ]),
          )
        : undefined;
    const usage =
      raw.usage && typeof raw.usage === "object"
        ? (raw.usage as Record<string, unknown>)
        : undefined;
    observed = {
      ...observed,
      model:
        typeof raw.model === "string" &&
        /^typesafe\/jev-1\.13(?:-\d{8})?$/.test(raw.model)
          ? raw.model
          : undefined,
      answers,
      usage: usage
        ? {
            input_tokens: numeric(usage.input_tokens),
            output_tokens: numeric(usage.output_tokens),
            cost: numeric(usage.cost),
          }
        : undefined,
    };
  }
  return response;
};
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const results: Record<string, unknown>[] = [];
try {
  for (const fixture of cases) {
    observed = { calls: 0 };
    const definitions = fixture.definitions || labels;
    const allowed = fixture.allowed || definitions.map((label) => label.name);
    const repository = fixture.repository || 100;
    const fullName = fixture.fullName || "synthetic/evaluation";
    const number = fixture.number || 1;
    if (!fullName.startsWith("synthetic"))
      throw new Error("Live write target must be synthetic");
    const candidateNames = [...new Set(allowed)].filter(
      (name) =>
        definitions.some((label) => label.name === name) &&
        name !== "." &&
        name !== ".." &&
        !name.toLowerCase().startsWith("review:"),
    );
    expectedDefinitions = candidateNames.map(
      (name) => definitions.find((label) => label.name === name)!,
    );
    const ledger: unknown[][] = [];
    const posts: { path: string; method: string; body: unknown }[] = [];
    let settingsReads = 0,
      labelReads = 0,
      rateWrites = 0;
    const database = {
      prepare(sql: string) {
        if (fixture.mode === "preview" && sql.startsWith("SELECT full_name"))
          return {
            bind(id: unknown) {
              if (id !== repository)
                throw new Error("Wrong preview settings scope");
              return {
                async first() {
                  settingsReads++;
                  return {
                    full_name: fullName,
                    issues_enabled: 1,
                    prs_enabled: 1,
                    comments_enabled: 0,
                    comment_prompt: "",
                    triage_enabled: 1,
                    allowed_labels: JSON.stringify(allowed),
                    backfill_limit: 25,
                  };
                },
              };
            },
          };
        if (
          fixture.mode === "preview" &&
          sql.startsWith("INSERT INTO api_rate")
        )
          return {
            bind(id: unknown) {
              if (id !== `intent-preview:${repository}`)
                throw new Error("Wrong preview rate scope");
              return {
                async first() {
                  rateWrites++;
                  return { count: 1 };
                },
              };
            },
          };
        if (!sql.startsWith("INSERT OR IGNORE INTO triage_labels"))
          throw new Error("Unexpected local SQL");
        return {
          bind(...values: unknown[]) {
            return { values };
          },
        };
      },
      async batch(statements: { values: unknown[] }[]) {
        ledger.push(...statements.map((statement) => statement.values));
        return [];
      },
    };
    const env = {
      TRIAGE_PROVIDER: "jev",
      OPENROUTER_API_KEY: key,
      JEV_MODEL,
      JEV_THRESHOLD: String(JEV_THRESHOLD),
      DB: database,
    } as unknown as Env;
    const api = async (path: string, method = "GET", body?: unknown) => {
      if (
        fixture.mode === "preview" &&
        path === `/repos/${fullName}/labels?per_page=100&page=1` &&
        method === "GET"
      ) {
        labelReads++;
        return definitions;
      }
      if (
        fixture.mode === "preview" ||
        path !== `/repos/${fullName}/issues/${number}/labels` ||
        method !== "POST"
      )
        throw new Error("Unexpected local GitHub action");
      const picked = (body as { labels: string[] }).labels;
      if (
        picked.length > 3 ||
        picked.some(
          (name) =>
            !allowed.includes(name) ||
            !definitions.some((label) => label.name === name) ||
            name.toLowerCase().startsWith("review:") ||
            name === "." ||
            name === "..",
        )
      )
        throw new Error("Disallowed local label POST");
      posts.push({ path, method, body });
      return {};
    };
    const start = performance.now();
    let previewLabels: string[] | undefined;
    const issue = {
      title: fixture.title,
      body: fixture.body,
      ...(fixture.pr ? { pull_request: {} } : {}),
    };
    const status =
      fixture.mode === "preview"
        ? await (async () => {
            const result = await runIntentPreview(
              env,
              api,
              repository,
              fullName,
              new URLSearchParams({
                preview_kind: fixture.pr ? "pull_request" : "issue",
                preview_title: fixture.title,
                preview_body: fixture.body,
              }),
            );
            previewLabels = result.classification.labels;
            return "previewed";
          })()
        : await triage(
            env,
            api,
            repository,
            fullName,
            number,
            issue,
            allowed,
            new Map(definitions.map((label) => [label.name, label])),
            new Map((fixture.current || []).map((name) => [name, { name }])),
            Date.now() + 60_000,
          );
    const actual =
      previewLabels?.slice().sort() ||
      posts
        .flatMap((post) => (post.body as { labels: string[] }).labels)
        .sort();
    const expected = [...fixture.expected].sort();
    const answers = observed.answers as
      | Record<string, { noul?: number }>
      | undefined;
    const ranked = candidateNames
      .map((name, index) => ({
        name,
        probability: answers?.[`label_${index}`]?.noul ?? -1,
      }))
      .filter((label) => label.probability >= JEV_THRESHOLD)
      .sort((a, b) => b.probability - a.probability);
    const exact = (a: string[], b: string[]) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const selectionPass =
      fixture.expectedCount === undefined
        ? exact(actual, expected)
        : actual.length === fixture.expectedCount &&
          exact(
            ranked.map((label) => label.name),
            expected,
          ) &&
          exact(
            actual,
            ranked.slice(0, fixture.expectedCount).map((label) => label.name),
          );
    const pass =
      selectionPass &&
      status !== "failed" &&
      ledger.length === (fixture.mode === "preview" ? 0 : actual.length) &&
      ledger.every(
        (row) =>
          row[0] === repository &&
          row[1] === number &&
          actual.includes(String(row[2])),
      ) &&
      (fixture.mode !== "preview" ||
        (posts.length === 0 &&
          settingsReads === 1 &&
          labelReads === 1 &&
          rateWrites === 1)) &&
      (!fixture.current || observed.calls === 0);
    const result = {
      id: fixture.id,
      kind: fixture.pr ? "pull_request" : "issue",
      mode: fixture.mode || "triage",
      repository,
      fullName,
      ...(fixture.sourceUrl ? { sourceUrl: fixture.sourceUrl } : {}),
      definitions: expectedDefinitions,
      probabilities: candidateNames.map((name, index) => ({
        name,
        probability: answers?.[`label_${index}`]?.noul,
      })),
      expected,
      ...(fixture.expectedCount === undefined
        ? {}
        : {
            expectationMode: "all-matches-capped",
            expectedSelectedCount: fixture.expectedCount,
          }),
      actual,
      status,
      pass,
      latencyMs: Math.round(performance.now() - start),
      postCount: posts.length,
      ledgerCount: ledger.length,
      settingsReads,
      labelReads,
      rateWrites,
      ...observed,
    };
    results.push(result);
    writeFileSync(
      resolve(out, `results-${runId}.json`),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          requestedModel: JEV_MODEL,
          suite,
          requestVersion,
          classifierSourceSha256,
          fixtureSha256,
          threshold: JEV_THRESHOLD,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify(result));
  }
} finally {
  globalThis.fetch = realFetch;
}
const failed = results.filter((result) => !result.pass);
console.log(
  JSON.stringify({
    passed: results.length - failed.length,
    total: results.length,
    failed: failed.map((result) => result.id),
  }),
);
if (failed.length) process.exitCode = 1;
