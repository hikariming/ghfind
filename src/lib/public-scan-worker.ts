import { createHash } from "node:crypto";
import {
  acquirePublicScanExecutionLease,
  acquirePublicScanRateWindow,
  claimPublicScanJob,
  completePublicScanRun,
  failPublicScanJob,
  getNextPublicScanCommitVerificationWork,
  getPublicScanContributionAggregates,
  getPublicScanOwnedRepoFacts,
  getPublicScanPrSummary,
  getPublicScanSignaturePrFacts,
  getPublicScanRun,
  materializePublicScanCommitRepoFacts,
  preparePublicScanCommitVerificationWork,
  PublicScanStorageError,
  savePublicScanJobProgress,
  savePublicScanQuickResult,
  splitPublicScanCommitVerificationWork,
  upsertPublicScanCommitCandidates,
  upsertPublicScanCommitRepoFacts,
  upsertPublicScanOwnedRepoFacts,
  upsertPublicScanPrFacts,
  recordPublicScanCommitVerificationPage,
  releasePublicScanExecutionLease,
  releasePublicScanJobClaim,
} from "./db";
import {
  fetchDurableOwnedRepositoryPage,
  fetchDurablePullRequestPage,
  hydrateTopRepoEvidence,
  listPublicDefaultBranchCommits,
  searchPublicCommitCandidates,
  verifyWorkflowLandedPublicScanFacts,
} from "./github";
import {
  applyPublicContributionAggregate,
  applyPublicOriginalRepoInventory,
  buildScanResult,
} from "./scan-core";
import { setCachedScan } from "./redis";
import type {
  PublicScanJobPhase,
  PublicScanSourceStatus,
} from "./scan-run-types";
import {
  PUBLIC_SCAN_COLLECTION_VERSION,
  hasCompletePublicScanSources,
} from "./scan-run-types";
import type { ScanResult, TopRepo } from "./types";

interface DiscoveryRange {
  from: string;
  to: string;
  page: number;
}

interface WorkerPayload {
  page?: number;
  after?: string | null;
  mode?: "discover" | "verify";
  ranges?: DiscoveryRange[];
}

class NonCanonicalPublicScanError extends Error {}

function publicScanErrorKind(error: unknown):
  | "non_canonical"
  | "rate_limited"
  | "timeout"
  | "upstream"
  | "invalid_state"
  | "unknown" {
  if (error instanceof NonCanonicalPublicScanError) return "non_canonical";
  const message = error instanceof Error ? error.message : "";
  if (/rate.?limit|secondary rate|quota/i.test(message)) return "rate_limited";
  if (/timeout|timed out|abort/i.test(message)) return "timeout";
  if (/github|graphql|http|fetch|upstream/i.test(message)) return "upstream";
  if (/missing|malformed|unsupported|disappeared|cannot be split/i.test(message)) {
    return "invalid_state";
  }
  return "unknown";
}

export type PublicScanWorkerResult =
  | { status: "idle" }
  | { status: "slot_busy"; jobId: string; runId: string; phase: PublicScanJobPhase }
  | { status: "continued"; jobId: string; runId: string; phase: PublicScanJobPhase }
  | { status: "complete"; jobId: string; runId: string; phase: "publish" }
  | {
      status: "failed";
      jobId: string;
      runId: string;
      phase: PublicScanJobPhase;
      retryScheduled: boolean;
    };

function parsePayload(raw: string): WorkerPayload {
  try {
    const value = JSON.parse(raw) as WorkerPayload;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function parseScan(raw: string | null): ScanResult {
  if (!raw) throw new Error("durable scan has no quick snapshot");
  const scan = JSON.parse(raw) as Partial<ScanResult>;
  if (!scan.metrics || !scan.scoring || !Array.isArray(scan.top_repos) || !Array.isArray(scan.recent_prs)) {
    throw new Error("durable scan quick snapshot is malformed");
  }
  return scan as ScanResult;
}

function sourceStatus(runStatus: PublicScanSourceStatus): PublicScanSourceStatus {
  return { ...runStatus };
}

function initialSources(): PublicScanSourceStatus {
  return {
    quick: "complete",
    original_repos: "pending",
    native_prs: "pending",
    workflow_landings: "pending",
    commit_recovery: "pending",
  };
}

function splitRange(range: DiscoveryRange): [DiscoveryRange, DiscoveryRange] {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from <= 1_000) {
    throw new Error("commit search interval cannot be split further");
  }
  const middle = from + Math.floor((to - from) / 2);
  return [
    { from: new Date(from).toISOString(), to: new Date(middle).toISOString(), page: 1 },
    { from: new Date(middle + 1).toISOString(), to: new Date(to).toISOString(), page: 1 },
  ];
}

function sourceComplete(sources: PublicScanSourceStatus): boolean {
  return hasCompletePublicScanSources(sources);
}

function toTopRepo(fact: Awaited<ReturnType<typeof getPublicScanOwnedRepoFacts>>[number]): TopRepo {
  return {
    name: fact.name,
    owner_login: fact.ownerLogin ?? fact.repoKey.split("/", 1)[0],
    name_with_owner: fact.repoKey,
    stars: fact.stars,
    forks: fact.forks,
    open_issues: fact.openIssues,
    size: fact.size,
    language: fact.language,
    description: fact.description,
    pushed_at: fact.pushedAt,
    topics: fact.topics,
  };
}

async function continueJob(input: {
  jobId: string;
  runId: string;
  leaseToken: string;
  phase: PublicScanJobPhase;
  payload: WorkerPayload;
  sources: PublicScanSourceStatus;
  delaySeconds?: number;
}): Promise<PublicScanWorkerResult> {
  const rawPayload = JSON.stringify(input.payload);
  const saved = await savePublicScanJobProgress({
    jobId: input.jobId,
    runId: input.runId,
    leaseToken: input.leaseToken,
    phase: input.phase,
    payload: rawPayload,
    sourceStatus: input.sources,
    nextRunAt:
      input.delaySeconds && input.delaySeconds > 0
        ? Date.now() + Math.ceil(input.delaySeconds * 1_000)
        : undefined,
  });
  if (!saved) return { status: "idle" };
  return {
    status: "continued",
    jobId: input.jobId,
    runId: input.runId,
    phase: input.phase,
  };
}

/**
 * Execute exactly one bounded collection step. The database job lease makes the
 * method safe across the dedicated worker service and request after-work; the
 * caller can safely treat a stale/no-op delivery as successful.
 */
export async function processPublicScanJob(
  input?: string | { jobId?: string; leaseMs?: number },
): Promise<PublicScanWorkerResult> {
  const jobId = typeof input === "string" ? input : input?.jobId;
  const leaseMs = typeof input === "string" ? undefined : input?.leaseMs;
  const lease = await claimPublicScanJob({
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    jobId,
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });
  if (!lease) return { status: "idle" };
  const { job, leaseToken } = lease;
  let executionSlot: number | null = null;
  try {
    if (job.collectionVersion !== PUBLIC_SCAN_COLLECTION_VERSION) {
      throw new NonCanonicalPublicScanError(
        "durable scan job uses a non-canonical collection version",
      );
    }
    executionSlot = await acquirePublicScanExecutionLease({
      jobId: job.id,
      leaseToken,
      ...(leaseMs === undefined ? {} : { leaseMs }),
    });
    if (executionSlot === null) {
      const released = await releasePublicScanJobClaim({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
      });
      return released
        ? { status: "slot_busy", jobId: job.id, runId: job.runId, phase: job.phase }
        : { status: "idle" };
    }
    const run = await getPublicScanRun(job.runId);
    if (!run) throw new Error("durable scan run disappeared");
    if (
      run.collectionVersion !== PUBLIC_SCAN_COLLECTION_VERSION ||
      run.collectionVersion !== job.collectionVersion
    ) {
      throw new NonCanonicalPublicScanError(
        "durable scan run uses a non-canonical collection version",
      );
    }
    const payload = parsePayload(job.payload);
    const sources = sourceStatus(run.sourceStatus);

    if (job.phase === "quick") {
      const quick = await buildScanResult(job.username);
      const seededSources = initialSources();
      const saved = await savePublicScanQuickResult({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        quickScan: JSON.stringify(quick),
        sourceStatus: seededSources,
      });
      if (!saved) return { status: "idle" };
      // When the contribution graph succeeds, retain its commit-only
      // aggregates before moving to the complete native PR inventory. The
      // durable PR phase then replaces only the PR portion; without this seed
      // a high-PR user would lose valid commit-only impact at publication.
      const graphCommitFacts = (quick.impact_repos ?? [])
        .filter((repo) => repo.commits > 0)
        .map((repo) => ({
          repoKey: repo.repo,
          ownerLogin: repo.repo.split("/", 1)[0] ?? null,
          stars: repo.stars,
          // `impact_repos` already passed the GraphQL collector's visibility
          // filtering. Commit-search recovery carries its own REST flags below.
          isPrivate: false,
          isFork: false,
          commits: repo.commits,
          activeYears: 0,
          firstCommittedAt: null,
          lastCommittedAt: null,
          source: "contribution_graph" as const,
          evidenceShas: [],
        }));
      if (
        !(await upsertPublicScanCommitRepoFacts({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          facts: graphCommitFacts,
        }))
      ) {
        return { status: "idle" };
      }
      return continueJob({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        phase: "original_repos",
        payload: { page: 1 },
        sources: seededSources,
      });
    }

    const quick = parseScan(run.quickScan);

    if (job.phase === "original_repos") {
      const page = Math.max(1, payload.page ?? 1);
      const result = await fetchDurableOwnedRepositoryPage({ username: job.username, page });
      const stored = await upsertPublicScanOwnedRepoFacts({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        facts: result.facts,
      });
      if (!stored) return { status: "idle" };
      if (result.hasNextPage) {
        return continueJob({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          phase: "original_repos",
          payload: { page: page + 1 },
          sources,
        });
      }
      sources.original_repos = "complete";
      return continueJob({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        phase: "merged_prs",
        payload: {},
        sources,
      });
    }

    if (job.phase === "merged_prs") {
      const page = await fetchDurablePullRequestPage({
        username: job.username,
        state: "MERGED",
        after: payload.after ?? null,
      });
      const stored = await upsertPublicScanPrFacts({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        facts: page.facts,
      });
      if (!stored) return { status: "idle" };
      if (page.hasNextPage && page.endCursor) {
        return continueJob({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          phase: "merged_prs",
          payload: { after: page.endCursor },
          sources,
        });
      }
      sources.native_prs = "complete";
      return continueJob({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        phase: "workflow_landings",
        payload: {},
        sources,
      });
    }

    if (job.phase === "workflow_landings") {
      const page = await fetchDurablePullRequestPage({
        username: job.username,
        state: "CLOSED",
        after: payload.after ?? null,
        includeLabels: true,
      });
      const stored = await upsertPublicScanPrFacts({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        facts: page.facts,
      });
      if (!stored) return { status: "idle" };
      const candidates = page.facts
        .filter((fact) => fact.labels.some((label) => label.trim().toLowerCase() === "merged"))
        .map((fact) => fact.pullRequestId);
      for (let i = 0; i < candidates.length; i += 25) {
        const verified = await verifyWorkflowLandedPublicScanFacts(candidates.slice(i, i + 25));
        if (
          verified.length > 0 &&
          !(await upsertPublicScanPrFacts({
            jobId: job.id,
            runId: job.runId,
            leaseToken,
            facts: verified,
          }))
        ) {
          return { status: "idle" };
        }
      }
      if (page.hasNextPage && page.endCursor) {
        return continueJob({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          phase: "workflow_landings",
          payload: { after: page.endCursor },
          sources,
        });
      }
      sources.workflow_landings = "complete";
      // The normal contribution graph already supplied its bounded
      // commit-only aggregate. REST commit recovery is only a fallback for the
      // GraphQL resource-limit failure; running it for every prolific PR author
      // would spend the scarce Search quota without adding new coverage.
      if (!quick.metrics.commit_contribution_aggregation_unavailable) {
        sources.commit_recovery = "complete";
        return continueJob({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          phase: "publish",
          payload: {},
          sources,
        });
      }
      const from = quick.metrics.created_at ?? "2008-01-01T00:00:00.000Z";
      return continueJob({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        phase: "commit_recovery",
        payload: { mode: "discover", ranges: [{ from, to: new Date().toISOString(), page: 1 }] },
        sources,
      });
    }

    if (job.phase === "commit_recovery") {
      if ((payload.mode ?? "discover") === "discover") {
        const ranges = payload.ranges ?? [];
        const current = ranges[0];
        if (!current) {
          const prepared = await preparePublicScanCommitVerificationWork({
            jobId: job.id,
            runId: job.runId,
            leaseToken,
          });
          if (!prepared) return { status: "idle" };
          return continueJob({
            jobId: job.id,
            runId: job.runId,
            leaseToken,
            phase: "commit_recovery",
            payload: { mode: "verify" },
            sources,
          });
        }
        // Commit Search has a much smaller global quota than normal GitHub REST
        // reads. Reserve from Turso before each page, so retried Cron work and
        // a Redis outage cannot stampede the shared token.
        const searchBudget = await acquirePublicScanRateWindow({
          bucket: "github-commit-search",
          limit: 20,
          windowMs: 60_000,
        });
        if (!searchBudget.granted) {
          return continueJob({
            jobId: job.id,
            runId: job.runId,
            leaseToken,
            phase: "commit_recovery",
            payload: { mode: "discover", ranges },
            sources,
            delaySeconds: Math.max(2, Math.ceil((searchBudget.retryAt - Date.now()) / 1_000)),
          });
        }
        const found = await searchPublicCommitCandidates({
          username: job.username,
          from: current.from,
          to: current.to,
          page: current.page,
        });
        if (found.incompleteResults || found.totalCount > 1_000) {
          const [left, right] = splitRange(current);
          return continueJob({
            jobId: job.id,
            runId: job.runId,
            leaseToken,
            phase: "commit_recovery",
            payload: { mode: "discover", ranges: [left, right, ...ranges.slice(1)] },
            sources,
          });
        }
        const stored = await upsertPublicScanCommitCandidates({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          candidates: found.candidates,
        });
        if (!stored) return { status: "idle" };
        const morePages = current.page * 100 < found.totalCount;
        const nextRanges = morePages
          ? [{ ...current, page: current.page + 1 }, ...ranges.slice(1)]
          : ranges.slice(1);
        return continueJob({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          phase: "commit_recovery",
          payload: { mode: "discover", ranges: nextRanges },
          sources,
        });
      }

      const work = await getNextPublicScanCommitVerificationWork(job.runId);
      if (!work) {
        const materialized = await materializePublicScanCommitRepoFacts({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
        });
        if (!materialized) return { status: "idle" };
        sources.commit_recovery = "complete";
        return continueJob({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          phase: "publish",
          payload: {},
          sources,
        });
      }
      const verified = await listPublicDefaultBranchCommits({
        repoKey: work.repoKey,
        username: job.username,
        from: work.from,
        to: work.to,
        page: work.page,
      });
      if (verified.hasNextPage && work.page >= 10) {
        const [left, right] = splitRange({ from: work.from, to: work.to, page: 1 });
        const split = await splitPublicScanCommitVerificationWork({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          work,
          left,
          right,
        });
        if (!split) return { status: "idle" };
      } else {
        const saved = await recordPublicScanCommitVerificationPage({
          jobId: job.id,
          runId: job.runId,
          leaseToken,
          work,
          commits: verified.commits,
          complete: !verified.hasNextPage,
        });
        if (!saved) return { status: "idle" };
      }
      return continueJob({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        phase: "commit_recovery",
        payload: { mode: "verify" },
        sources,
      });
    }

    if (job.phase === "publish") {
      if (!sourceComplete(sources)) {
        throw new Error("cannot publish a partial public scan");
      }
      const [aggregates, summary, ownedFacts, signaturePrFacts] = await Promise.all([
        getPublicScanContributionAggregates(job.runId),
        getPublicScanPrSummary(job.runId, job.username),
        getPublicScanOwnedRepoFacts(job.runId),
        getPublicScanSignaturePrFacts(job.runId),
      ]);
      const owned = ownedFacts.map(toTopRepo);
      const candidates = [
        ...owned.slice(0, 12),
        ...[...owned].sort((a, b) => b.size - a.size || b.stars - a.stars).slice(0, 12),
      ];
      const evidenceRepos = [...new Map(candidates.map((repo) => [repo.name_with_owner!, repo])).values()];
      await hydrateTopRepoEvidence(evidenceRepos, job.username, 24);
      const evidenceByName = new Map(evidenceRepos.map((repo) => [repo.name_with_owner!, repo]));
      const enrichedOwned = owned.map((repo) => evidenceByName.get(repo.name_with_owner!) ?? repo);
      const contributionRepos = aggregates.map((repo) => ({
        repo: repo.repo,
        stars: repo.stars,
        is_private: repo.isPrivate,
        is_fork: repo.isFork,
        owner_login: repo.ownerLogin,
        commits: repo.commits,
        prs: repo.prs,
        active_years: repo.activeYears,
      }));
      const withOriginalInventory = applyPublicOriginalRepoInventory(quick, enrichedOwned);
      const completed = applyPublicContributionAggregate(withOriginalInventory, contributionRepos, {
        total: summary.workflowLandedPrs,
        impact: summary.workflowLandedImpactPrs,
      }, signaturePrFacts);
      const snapshot = JSON.stringify(completed);
      const published = await completePublicScanRun({
        jobId: job.id,
        runId: job.runId,
        leaseToken,
        coverage: "complete_public",
        sourceStatus: sources,
        snapshot,
        snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
      });
      if (!published) return { status: "idle" };
      await setCachedScan(completed.metrics.username, completed);
      return { status: "complete", jobId: job.id, runId: job.runId, phase: "publish" };
    }

    throw new Error(`unsupported durable scan phase: ${job.phase}`);
  } catch (error) {
    if (error instanceof PublicScanStorageError) throw error;
    const kind = publicScanErrorKind(error);
    const retryAt =
      !(error instanceof NonCanonicalPublicScanError) && job.attemptCount < 4
        ? Date.now() + 5_000 * 2 ** job.attemptCount
        : undefined;
    const failed = await failPublicScanJob({
      jobId: job.id,
      runId: job.runId,
      leaseToken,
      error: `worker_${kind}`,
      retryAt,
    });
    if (!failed) return { status: "idle" };
    console.error(
      "public_scan.step_failed",
      JSON.stringify({
        jobId: job.id,
        runId: job.runId,
        phase: job.phase,
        kind,
        retryScheduled: retryAt !== undefined,
      }),
    );
    return {
      status: "failed",
      jobId: job.id,
      runId: job.runId,
      phase: job.phase,
      retryScheduled: retryAt !== undefined,
    };
  } finally {
    if (executionSlot !== null) {
      await releasePublicScanExecutionLease({
        slot: executionSlot,
        jobId: job.id,
        leaseToken,
      });
    }
  }
}
