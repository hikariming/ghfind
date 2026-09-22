/**
 * `ghfind/local` — LOCAL deterministic scoring (Node-only).
 *
 * This entry point bundles the *actual* open-source scoring core from the ghfind
 * website (`src/lib/score.ts` + `src/lib/github.ts`) — not a copy — so results are
 * byte-for-byte identical to the site and can never drift. With your own GitHub
 * token you can score any account entirely on your own machine and quota, WITHOUT
 * calling the ghfind server at all. No LLM is involved.
 *
 * Import it only when you want local scoring — the main `ghfind` entry stays a
 * tiny dependency-free remote client and does NOT pull this core in.
 *
 *   import { collectAndScore } from "ghfind/local";
 *   const scan = await collectAndScore("torvalds", { token: process.env.GITHUB_TOKEN });
 *   console.log(scan.scoring.final_score, scan.scoring.red_flags);
 *
 * No token? Use the remote client instead: `new GhFind().getScore(username)` —
 * the ghfind server does the crawl + deterministic scoring for you.
 */

import {
  AccountNotFoundError,
  GitHubAuthRequiredError,
  GitHubDataUnavailableError,
  GitHubRateLimitError,
  collect,
  withGithubToken,
} from "../../../src/lib/github";
import { score } from "../../../src/lib/score";
import type { RawMetrics, ScanResult, Scoring } from "./types.js";

export {
  AccountNotFoundError,
  GitHubAuthRequiredError,
  GitHubDataUnavailableError,
  GitHubRateLimitError,
};

/** Run the pure deterministic scorer over metrics you already have. No I/O. */
export function scoreMetrics(metrics: RawMetrics): Scoring {
  return score(metrics as never) as unknown as Scoring;
}

export interface LocalScanOptions {
  /** GitHub token used for the crawl. Falls back to `process.env.GITHUB_TOKEN`.
   * Local scoring makes many authenticated GitHub API calls, so a token is
   * required (an unauthenticated crawl would hit GitHub's 60/h limit instantly). */
  token?: string;
}

/**
 * Crawl GitHub and compute the full deterministic scan + score locally.
 *
 * Identical output shape to `POST /api/scan` / the remote client's `scan()`, but
 * runs entirely on your machine and your GitHub token. Throws the GitHub error
 * classes re-exported above (`AccountNotFoundError` for a nonexistent login, etc.).
 */
export async function collectAndScore(
  username: string,
  opts: LocalScanOptions = {},
): Promise<ScanResult> {
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? "";
  if (!token.trim()) {
    throw new GitHubAuthRequiredError(
      "collectAndScore needs a GitHub token: pass { token } or set GITHUB_TOKEN. " +
        "Local scoring makes many authenticated GitHub API calls.",
    );
  }
  return withGithubToken(token, async () => {
    const data = await collect(username);
    return { ...data, scoring: score(data.metrics) } as unknown as ScanResult;
  });
}
