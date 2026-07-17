/**
 * Durable public-history scan contracts. These types intentionally sit outside
 * the GitHub collector and scorer: collection completeness is a property of a
 * data snapshot, not of the deterministic scoring formula.
 */

export const PUBLIC_SCAN_COLLECTION_VERSION = "v1";

export type PublicScanRunState =
  | "queued"
  | "running"
  | "complete_public"
  | "partial_public"
  | "failed";

export type PublicScanCoverage = "partial_public" | "complete_public";

export type PublicScanJobPhase =
  | "quick"
  | "original_repos"
  | "merged_prs"
  | "workflow_landings"
  | "commit_recovery"
  | "publish";

export type PublicScanSourceState = "pending" | "complete" | "unavailable" | "failed";

export type PublicScanSourceStatus = Record<string, PublicScanSourceState>;

export interface PublicScanRun {
  id: string;
  username: string;
  scoreVersion: string;
  collectionVersion: string;
  state: PublicScanRunState;
  coverage: PublicScanCoverage;
  sourceStatus: PublicScanSourceStatus;
  quickScan: string | null;
  snapshot: string | null;
  snapshotHash: string | null;
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
  lastError: string | null;
}

export interface PublicScanJob {
  id: string;
  runId: string;
  username: string;
  scoreVersion: string;
  collectionVersion: string;
  state: "queued" | "running" | "failed" | "complete";
  phase: PublicScanJobPhase;
  payload: string;
  attemptCount: number;
  nextRunAt: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublicScanJobLease {
  job: PublicScanJob;
  leaseToken: string;
}

export interface PublicScanPrFact {
  pullRequestId: string;
  source: "native_merged" | "workflow_landed" | "closed";
  repoKey: string | null;
  ownerLogin: string | null;
  stars: number;
  isPrivate: boolean;
  isFork: boolean;
  createdAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  title: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  labels: string[];
}

export interface PublicScanCommitRepoFact {
  repoKey: string;
  ownerLogin: string | null;
  stars: number;
  commits: number;
  activeYears: number;
  firstCommittedAt: string | null;
  lastCommittedAt: string | null;
  source: "contribution_graph" | "default_branch_rest";
  evidenceShas: string[];
}
