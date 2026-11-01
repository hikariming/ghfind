// Offline only. Read sanitized jev-live results; never read credentials or call APIs.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  fixtures,
  heldoutFixtures,
  heldoutExtraFixtures,
  labels,
} from "./jev-fixtures.ts";
interface Result {
  id: string;
  expected: string[];
  pass: boolean;
  calls: number;
  latencyMs: number;
  answers?: Record<string, { noul: number }>;
  usage?: { input_tokens: number; output_tokens: number; cost: number };
}
interface Experiment {
  requestVersion?: string;
  suite?: string;
  classifierSourceSha256?: string;
  results: Result[];
}
const directory = resolve(process.env.JEV_EVAL_OUTPUT || "tmp/saas-jev-live");
const cases = new Map(
  [...fixtures, ...heldoutFixtures, ...heldoutExtraFixtures].map((fixture) => [
    fixture.id,
    fixture,
  ]),
);
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(path, entry.name))
      : /^results(?:-.*)?\.json$/.test(entry.name)
        ? [resolve(path, entry.name)]
        : [],
  );
}
const runs = files(directory)
  .sort()
  .map((file) => ({
    file: relative(directory, file),
    data: JSON.parse(readFileSync(file, "utf8")) as Experiment,
  }));
const experiments = runs.map(({ file, data }) => {
  const billed = data.results.filter(
    (result) => result.usage && Number.isFinite(result.usage.cost),
  );
  const requests = data.results.filter((result) => result.calls > 0);
  return {
    file,
    requestVersion: data.requestVersion,
    suite: data.suite,
    classifierSourceSha256: data.classifierSourceSha256,
    fixtures: data.results.length,
    passed: data.results.filter((result) => result.pass).length,
    requestCount: requests.length,
    usageCount: billed.length,
    inputTokens: billed.reduce(
      (sum, result) => sum + result.usage!.input_tokens,
      0,
    ),
    costUsd: billed.reduce((sum, result) => sum + result.usage!.cost, 0),
    meanRequestLatencyMs:
      requests.reduce((sum, result) => sum + result.latencyMs, 0) /
      (requests.length || 1),
  };
});
const holdout = runs
  .filter(
    ({ data }) => data.suite === "holdout" || data.suite === "holdout-extra",
  )
  .flatMap(({ data }) => data.results);
const sweep = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map((threshold) => {
  let tp = 0,
    fp = 0,
    fn = 0;
  for (const result of holdout) {
    const fixture = cases.get(result.id);
    if (!fixture || !result.answers)
      throw new Error("Missing holdout evidence");
    const definitions = fixture.definitions || labels;
    const names = [
      ...new Set(fixture.allowed || definitions.map((label) => label.name)),
    ].filter(
      (name) =>
        definitions.some((label) => label.name === name) &&
        name !== "." &&
        name !== ".." &&
        !name.toLowerCase().startsWith("review:"),
    );
    for (const [index, name] of names.entries()) {
      const probability = result.answers[`label_${index}`]?.noul;
      if (
        typeof probability !== "number" ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
      )
        throw new Error("Invalid holdout evidence");
      const actual = fixture.expected.includes(name),
        predicted = probability >= threshold;
      if (predicted && actual) tp++;
      else if (predicted) fp++;
      else if (actual) fn++;
    }
  }
  return {
    threshold,
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
  };
});
const summary = {
  experiments,
  totals: {
    requestCount: experiments.reduce((sum, run) => sum + run.requestCount, 0),
    requestsWithUsage: experiments.reduce(
      (sum, run) => sum + run.usageCount,
      0,
    ),
    inputTokens: experiments.reduce((sum, run) => sum + run.inputTokens, 0),
    reportedCostUsd: experiments.reduce((sum, run) => sum + run.costUsd, 0),
  },
  heldout: {
    fixtures: holdout.length,
    sweep,
    limit:
      "Small synthetic holdout only; this is not an estimate of production precision or recall.",
  },
  scope:
    "Classifier-script result files only. Separate browser/Worker E2E costs are reported separately. Missing usage is not counted as free.",
};
writeFileSync(
  resolve(directory, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary));
