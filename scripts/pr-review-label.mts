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

export async function fetchScore(username: string): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`https://ghfind.com/api/score/${encodeURIComponent(username)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const score = body && typeof body === "object" && "final_score" in body ? body.final_score : null;
    return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100
      ? score
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
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

export async function syncReviewLabel(
  repository: string,
  prNumber: number,
  target: ReviewLabel,
  token: string,
): Promise<void> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !Number.isSafeInteger(prNumber) || prNumber <= 0 || !token.trim()) {
    throw new Error("Repository, positive PR number, and GitHub token are required");
  }
  if (!REVIEW_LABELS.includes(target)) throw new Error("Unknown review-level label");
  const repoPath = repository.split("/").map(encodeURIComponent).join("/");
  const targetPath = `/labels/${encodeURIComponent(target)}`;

  async function request(method: string, path: string, body?: { labels: ReviewLabel[] }) {
    const response = await fetch(`https://api.github.com/repos/${repoPath}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404 && path === targetPath) {
      throw new Error(`Configuration error: required repository label "${target}" is missing or inaccessible; create it before running this workflow`);
    }
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (HTTP ${response.status})`);
    return response;
  }

  // A missing repository label is a configuration error; never create labels here.
  await request("GET", targetPath);
  const labelsPath = `/issues/${prNumber}/labels`;
  const currentLabels = new Set<string>();
  for (let page = 1; ; page++) {
    const response = await request("GET", `${labelsPath}?per_page=100&page=${page}`);
    const labels: unknown = await response.json();
    if (!Array.isArray(labels) || labels.some((label) => !label || typeof label.name !== "string")) {
      throw new Error("GitHub returned an invalid PR labels response");
    }
    for (const label of labels) currentLabels.add(label.name);
    if (labels.length < 100) break;
  }

  // Add first, so an API failure cannot leave the PR with no review level.
  if (!currentLabels.has(target)) await request("POST", labelsPath, { labels: [target] });
  for (const label of REVIEW_LABELS) {
    if (label !== target && currentLabels.has(label)) {
      await request("DELETE", `${labelsPath}/${encodeURIComponent(label)}`);
    }
  }
}

export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = env;
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
  const score = await fetchScore(username);
  const label = scoreToLabel(score);
  await syncReviewLabel(repository, prNumber, label, token);
  console.log(`${repository}#${prNumber}: ${label} (score: ${score ?? "unavailable"})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "PR review label sync failed");
    process.exitCode = 1;
  });
}
