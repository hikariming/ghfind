/**
 * Phase registry of the devscore collector. Each runner reads earlier phases' outputs via
 * `ctx.get(phase)` and returns its own JSON-serialisable output (see the *Out types).
 */
import type { PhaseRunner } from "./index";
import type { CollectPhase } from "./types";
import { runContribs, runMergedPrs, runRejected, runUser } from "./phase-user";
import { runGapFill, runMaintainer } from "./phase-maint";
import {
  runAssemble,
  runExtPrs,
  runHistories,
  runMutualMergers,
  runOwnerTypes,
  runPerRepo,
  runPrDetails,
  runPrSamples,
  runRepoMeta,
  runSignals,
  runStarHistory,
} from "./phase-repos";

export const PHASE_RUNNERS: Record<CollectPhase, PhaseRunner> = {
  user: runUser,
  contribs: runContribs,
  maintainer: runMaintainer,
  gap_fill: runGapFill,
  merged_prs: runMergedPrs,
  repo_meta: runRepoMeta,
  pr_samples: runPrSamples,
  pr_details: runPrDetails,
  mutual_mergers: runMutualMergers,
  histories: runHistories,
  signals: runSignals,
  per_repo: runPerRepo,
  owner_types: runOwnerTypes,
  star_history: runStarHistory,
  rejected: runRejected,
  ext_prs: runExtPrs,
  assemble: runAssemble,
};
