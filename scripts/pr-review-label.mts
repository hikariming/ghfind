import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const REVIEW_LABELS = [
  "review-level: low",
  "review-level: medium",
  "review-level: high",
  "review-level: xhigh",
  "review-level: unavailable",
] as const;

export type ReviewLabel = (typeof REVIEW_LABELS)[number];

interface RetryContext {
  budget: { retries: number };
  deadline: number;
  notBefore: number;
  secondaryLimits: number;
}

function retryContext(): RetryContext {
  return { budget: { retries: 0 }, deadline: Date.now() + 8 * 60_000, notBefore: 0, secondaryLimits: 0 };
}

class RunDeadlineError extends Error {
  constructor() { super("Bot execution exceeded its 8-minute time budget"); }
}

class RetryableError extends Error {
  waitMs = 0;
  ambiguous = false;
}

function transportError(message: string): RetryableError {
  return Object.assign(new RetryableError(message), { ambiguous: true });
}

async function waitUntil(time: number, context: RetryContext): Promise<void> {
  if (Date.now() >= context.deadline || time >= context.deadline) throw new RunDeadlineError();
  const delay = time - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (Date.now() >= context.deadline) throw new RunDeadlineError();
}

async function httpError(response: Response, github: boolean, context: RetryContext, message: string): Promise<Error> {
  const status = response.status;
  let limited = status === 429 || (github && status === 403 && (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  ));
  let bodyFailed = false;
  if (status === 403 && !limited) {
    try {
      const detail = await response.text();
      limited = github && /secondary rate limit|rate limit exceeded|abuse detection/i.test(detail);
    } catch {
      bodyFailed = true;
    }
  } else {
    // Header/status classification must survive a broken or stalled body cleanup.
    void response.body?.cancel().catch(() => {});
  }
  if (!limited && !bodyFailed && ![408, 500, 502, 503, 504].includes(status)) return new Error(message);
  const error = Object.assign(new RetryableError(message), { ambiguous: !limited });
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay)) error.waitMs = Math.max(0, delay);
  }
  if (github && limited) {
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
    if (response.headers.get("x-ratelimit-remaining") === "0" && reset > Date.now()) {
      error.waitMs = Math.max(error.waitMs, reset - Date.now());
    }
    // GitHub requires at least a minute for secondary limits without a usable server delay.
    if (error.waitMs === 0) error.waitMs = 60_000 * 2 ** context.secondaryLimits++;
  }
  return error;
}

async function request(
  url: string,
  init: RequestInit,
  context: RetryContext,
  readJSON = false,
  confirm?: () => Promise<boolean>,
): Promise<unknown> {
  for (;;) {
    await waitUntil(context.notBefore, context);
    const controller = new AbortController();
    const remaining = context.deadline - Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // A race enforces the deadline even if fetch or body reading ignores abort.
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(remaining <= 60_000 ? new RunDeadlineError() : transportError("Request timed out after 60 seconds"));
        controller.abort();
      }, Math.min(60_000, remaining));
    });
    try {
      return await Promise.race([
        deadline,
        (async () => {
          let response: Response;
          try {
            response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
          } catch {
            throw transportError("Network request failed");
          }
          if (controller.signal.aborted) throw transportError("Request completed after its deadline");
          if (!response.ok) throw await httpError(response, new URL(url).hostname === "api.github.com", context,
            `${init.method ?? "GET"} ${url} failed (HTTP ${response.status})`);
          if (!readJSON) {
            // Successful writes must not depend on response body cleanup completing.
            void response.body?.cancel().catch(() => {});
            return;
          }
          try {
            return await response.json();
          } catch (error) {
            if (error instanceof SyntaxError) throw error;
            throw transportError("Response body could not be read");
          }
        })(),
      ]);
    } catch (error) {
      clearTimeout(timeout);
      controller.abort();
      if (!(error instanceof RetryableError)) throw error;
      context.notBefore = Math.max(context.notBefore, Date.now() + error.waitMs);
      // A write may have succeeded before its response was lost. Confirm before replaying it.
      if (error.ambiguous && confirm && await confirm()) return;
      if (context.budget.retries >= 7) throw error;
      const delay = Math.max(Math.min(5_000 * 2 ** context.budget.retries, 20_000), context.notBefore - Date.now());
      if (Date.now() + delay >= context.deadline) throw new RunDeadlineError();
      context.budget.retries++;
      console.warn(`Retry ${context.budget.retries}/7 in ${delay / 1_000}s: ${error.message}`);
      await waitUntil(Date.now() + delay, context);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function fetchScore(username: string, context = retryContext()): Promise<number | null> {
  // Reserve the final four minutes for GitHub; share retries, but not server cooldowns.
  const scoreContext = { ...context, deadline: context.deadline - 4 * 60_000, notBefore: 0, secondaryLimits: 0 };
  try {
    const body = await request(`https://ghfind.com/api/score/${encodeURIComponent(username)}`, {
      method: "GET", headers: { Accept: "application/json" },
    }, scoreContext, true);
    const score = body && typeof body === "object" && "final_score" in body ? body.final_score : null;
    return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
  } catch {
    return null;
  }
}

// Scores are validated by fetchScore before classification.
export function scoreToLabel(score: number | null): ReviewLabel {
  if (score === null) return "review-level: unavailable";
  if (score < 40) return "review-level: low";
  if (score < 70) return "review-level: medium";
  if (score < 90) return "review-level: high";
  return "review-level: xhigh";
}

export async function setupReviewLabels(repository: string, token: string, initialize = false, context = retryContext()): Promise<void> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !token.trim()) {
    throw new Error("Repository and GitHub token are required");
  }
  const repoPath = repository.split("/").map(encodeURIComponent).join("/");
  const base = `https://api.github.com/repos/${repoPath}/labels`;
  const headers = {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json",
  };
  async function missingLabels(): Promise<ReviewLabel[]> {
    const names = new Set<string>();
    for (let page = 1; ; page++) {
      const body = await request(`${base}?per_page=100&page=${page}`, { method: "GET", headers }, context, true);
      if (!Array.isArray(body) || body.some((label) => !label || typeof label.name !== "string")) {
        throw new Error("GitHub returned an invalid repository labels response");
      }
      for (const label of body) names.add(label.name);
      if (body.length < 100) return REVIEW_LABELS.filter((label) => !names.has(label));
    }
  }
  let missing = await missingLabels();
  if (initialize) {
    const descriptions: Record<ReviewLabel, string> = {
      "review-level: low": "ghfind author score: 0 <= score < 40",
      "review-level: medium": "ghfind author score: 40 <= score < 70",
      "review-level: high": "ghfind author score: 70 <= score < 90",
      "review-level: xhigh": "ghfind author score: 90 <= score <= 100",
      "review-level: unavailable": "ghfind author score unavailable or invalid (not a zero score)",
    };
    for (const name of missing) {
      const exists = async () => !(await missingLabels()).includes(name);
      try {
        await request(base, {
          method: "POST", headers, body: JSON.stringify({ name, color: "ededed", description: descriptions[name] }),
        }, context, false, exists);
      } catch (error) {
        // Another initializer may have created it. Never update an existing label.
        if (!(error instanceof Error && error.message.endsWith("(HTTP 422)") && await exists())) throw error;
      }
    }
    missing = await missingLabels();
  }
  if (missing.length) {
    throw new Error(`Configuration error: missing repository labels: ${missing.join(", ")}. ` +
      "Label names are case-sensitive; rename any differently cased existing labels to the exact required names. " +
      `Open https://github.com/${repoPath}/labels and use New label, or open ` +
      `https://github.com/${repoPath}/actions/workflows/pr-review-label.yml and Run workflow with initialize enabled. ` +
      "Locally: set GITHUB_REPOSITORY and GITHUB_TOKEN, then run node --experimental-strip-types scripts/pr-review-label.mts --init-labels. " +
      "Initialization only creates missing labels and preserves existing colors/descriptions.");
  }
  console.log(`${repository}: all five review-level labels are ready`);
}

export async function syncReviewLabel(
  repository: string,
  prNumber: number,
  target: ReviewLabel,
  token: string,
  context = retryContext(),
): Promise<void> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !Number.isSafeInteger(prNumber) || prNumber <= 0 || !token.trim()) {
    throw new Error("Repository, positive PR number, and GitHub token are required");
  }
  if (!REVIEW_LABELS.includes(target)) throw new Error("Unknown review-level label");
  const repoPath = repository.split("/").map(encodeURIComponent).join("/");
  const targetPath = `/labels/${encodeURIComponent(target)}`;

  async function githubRequest(method: string, path: string, body?: { labels: ReviewLabel[] }, confirm?: () => Promise<boolean>) {
    return request(`https://api.github.com/repos/${repoPath}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }, context, method === "GET", confirm);
  }

  // A missing repository label is a configuration error; never create labels here.
  try {
    const label = await githubRequest("GET", targetPath);
    if (!label || typeof label !== "object" || !("name" in label) || label.name !== target) {
      throw new Error(`Configuration error: required repository label must be named exactly "${target}" (case-sensitive); check its name before running this workflow`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("(HTTP 404)")) {
      throw new Error(`Configuration error: required repository label "${target}" is missing or inaccessible; create it before running this workflow`);
    }
    throw error;
  }
  const labelsPath = `/issues/${prNumber}/labels`;
  async function readLabels(): Promise<Set<string>> {
    const labels = new Set<string>();
    for (let page = 1; ; page++) {
      const body = await githubRequest("GET", `${labelsPath}?per_page=100&page=${page}`);
      if (!Array.isArray(body) || body.some((label) => !label || typeof label.name !== "string")) {
        throw new Error("GitHub returned an invalid PR labels response");
      }
      for (const label of body) labels.add(label.name);
      if (body.length < 100) return labels;
    }
  }
  const currentLabels = await readLabels();

  // Add first, so an API failure cannot leave the PR with no review level.
  if (!currentLabels.has(target)) await githubRequest("POST", labelsPath, { labels: [target] },
    async () => (await readLabels()).has(target));
  for (const label of REVIEW_LABELS) {
    if (label !== target && currentLabels.has(label)) {
      await githubRequest("DELETE", `${labelsPath}/${encodeURIComponent(label)}`, undefined,
        async () => !(await readLabels()).has(label));
    }
  }
}

export async function main(env: Readonly<Record<string, string | undefined>> = process.env, args: string[] = []): Promise<void> {
  const context = retryContext();
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = env;
  if (args.length) {
    if (args.length !== 1 || !["--check-labels", "--init-labels"].includes(args[0])) throw new Error("Expected --check-labels or --init-labels");
    if (!repository || !token?.trim()) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
    await setupReviewLabels(repository, token, args[0] === "--init-labels", context);
    return;
  }
  if (!eventPath || !repository || !token?.trim()) {
    throw new Error("GITHUB_EVENT_PATH, GITHUB_REPOSITORY, and GITHUB_TOKEN are required");
  }
  const event = JSON.parse(await readFile(eventPath, "utf8")) as {
    action?: unknown;
    number?: unknown;
    pull_request?: { user?: { login?: unknown } };
  } | null;
  const username = event?.pull_request?.user?.login;
  const prNumber = event?.number;
  if (
    env.GITHUB_EVENT_NAME !== "pull_request_target" || event?.action !== "opened" ||
    typeof username !== "string" || !username.trim() ||
    typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0
  ) {
    throw new Error("Expected a pull_request_target opened event with a PR author and positive PR number");
  }
  await setupReviewLabels(repository, token, false, context);
  const score = await fetchScore(username, context);
  const label = scoreToLabel(score);
  await syncReviewLabel(repository, prNumber, label, token, context);
  console.log(`${repository}#${prNumber}: ${label} (score: ${score ?? "unavailable"})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env, process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "PR review label sync failed");
    process.exitCode = 1;
  });
}
