import { CircleCheck, Clock3, History } from "lucide-react";
import type { ReactNode } from "react";
import { ROAST_CACHE_VERSION } from "@/lib/cache-version";
import { isCurrentScoreProvenance } from "@/lib/score-version";

export type ProfileArtifactState = "stale-score" | "report-pending" | "ready";

export function shouldStartProfileRoast({
  explicitHandoff,
  hasReport,
  staleReport,
}: {
  explicitHandoff: boolean;
  hasReport: boolean;
  staleReport: boolean;
}): boolean {
  return explicitHandoff && (!hasReport || staleReport);
}

export function resolveProfileArtifactState({
  scoreVersion,
  sourceCollectionVersion,
  sourceSnapshotHash,
  roastVersion,
}: {
  scoreVersion: string | null | undefined;
  sourceCollectionVersion: string | null | undefined;
  sourceSnapshotHash: string | null | undefined;
  roastVersion: string | null | undefined;
}): ProfileArtifactState {
  if (!isCurrentScoreProvenance({ scoreVersion, sourceCollectionVersion, sourceSnapshotHash })) {
    return "stale-score";
  }
  if (roastVersion !== ROAST_CACHE_VERSION) return "report-pending";
  return "ready";
}

const STATUS_STYLE = {
  "stale-score": {
    Icon: History,
    iconClass: "text-amber-300",
  },
  "report-pending": {
    Icon: Clock3,
    iconClass: "text-orange-300",
  },
  ready: {
    Icon: CircleCheck,
    iconClass: "text-emerald-300",
  },
} satisfies Record<
  ProfileArtifactState,
  { Icon: typeof History; iconClass: string }
>;

export function ProfileArtifactStatus({
  state,
  title,
  body,
  action,
}: {
  state: ProfileArtifactState;
  title: string;
  body: string;
  /** Optional control under the copy (the stale-score re-evaluate action). */
  action?: ReactNode;
}) {
  const { Icon, iconClass } = STATUS_STYLE[state];

  return (
    <div
      role="status"
      data-profile-artifact-state={state}
      className="flex items-start gap-2.5 border-s-2 border-white/10 px-3 py-1.5"
    >
      <Icon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${iconClass}`} />
      <div className="min-w-0 text-start">
        <div className="text-xs font-semibold text-zinc-200">{title}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{body}</p>
        {action}
      </div>
    </div>
  );
}
