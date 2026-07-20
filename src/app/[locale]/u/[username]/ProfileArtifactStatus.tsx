import { CircleCheck, Clock3, History } from "lucide-react";
import { ROAST_CACHE_VERSION, SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";

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
  const hasCanonicalScoreProvenance =
    scoreVersion === SCORE_CACHE_VERSION &&
    sourceCollectionVersion === PUBLIC_SCAN_COLLECTION_VERSION &&
    typeof sourceSnapshotHash === "string" &&
    /^[a-f0-9]{64}$/.test(sourceSnapshotHash);
  if (!hasCanonicalScoreProvenance) return "stale-score";
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
}: {
  state: ProfileArtifactState;
  title: string;
  body: string;
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
      </div>
    </div>
  );
}
