import type { ScoreBreakdown as ScoreBreakdownData } from "@/lib/profile-presentation";

interface ScoreBreakdownCopy {
  base: string;
  adjustment: string;
  inferredAdjustment: string;
  final: string;
  heading: string;
  note: string;
  riskHeading: string;
  unavailable: string;
  capNote: string;
  more: string;
}

interface ScoreBreakdownProps {
  breakdown: ScoreBreakdownData;
  finalScore: number;
  copy: ScoreBreakdownCopy;
  flagLabel: (flag: string) => string;
}

function score(value: number): string {
  return value.toFixed(2);
}

export function ScoreBreakdownSummary({
  breakdown,
  copy,
}: Pick<ScoreBreakdownProps, "breakdown" | "copy">) {
  if (breakdown.applied_penalty <= 0.005) return null;

  const adjustmentLabel = breakdown.complete ? copy.adjustment : copy.inferredAdjustment;

  return (
    <a
      href="#score-breakdown"
      className="mt-1.5 inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-full border border-white/10 bg-white/[0.02] px-2.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
    >
      <span>{copy.base} <strong className="font-semibold tabular-nums text-zinc-200">{score(breakdown.base_score)}</strong></span>
      <span aria-hidden="true" className="text-zinc-600">·</span>
      <span>{adjustmentLabel} <strong className="font-semibold tabular-nums text-amber-300">−{score(breakdown.applied_penalty)}</strong></span>
    </a>
  );
}

function RiskRows({
  flags,
  flagLabel,
}: {
  flags: ScoreBreakdownData["red_flags"];
  flagLabel: (flag: string) => string;
}) {
  return (
    <ul className="space-y-1.5">
      {flags.map((flag, index) => (
        <li
          key={`${flag.flag}-${index}`}
          className="flex items-start justify-between gap-3 rounded-md border border-white/10 bg-white/[0.02] px-2.5 py-1.5"
        >
          <span className="min-w-0 text-left">
            <span className="block text-xs leading-5 text-zinc-300">{flagLabel(flag.flag)}</span>
            {flag.detail ? (
              <span className="mt-0.5 block text-[10px] leading-4 text-zinc-500">{flag.detail}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs font-semibold tabular-nums text-amber-300">
            −{score(flag.penalty)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ScoreBreakdown({
  breakdown,
  finalScore,
  copy,
  flagLabel,
}: ScoreBreakdownProps) {
  if (breakdown.applied_penalty <= 0.005) return null;

  const visibleFlags = breakdown.red_flags.slice(0, 3);
  const remainingFlags = breakdown.red_flags.slice(3);
  const adjustmentWasLimited = Math.abs(breakdown.total_penalty - breakdown.applied_penalty) > 0.005;
  const adjustmentLabel = breakdown.complete ? copy.adjustment : copy.inferredAdjustment;

  return (
    <div id="score-breakdown" className="mt-4 scroll-mt-24 rounded-lg border border-amber-300/20 bg-amber-500/[0.04] p-3">
      <h3 className="text-xs font-bold text-zinc-200">{copy.heading}</h3>
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1.5 text-center">
        <div>
          <div className="text-[11px] text-zinc-500">{copy.base}</div>
          <div className="mt-0.5 text-base font-bold tabular-nums text-zinc-100">{score(breakdown.base_score)}</div>
        </div>
        <span aria-hidden="true" className="text-sm font-semibold text-zinc-500">−</span>
        <div>
          <div className="text-[11px] text-zinc-500">{adjustmentLabel}</div>
          <div className="mt-0.5 text-base font-bold tabular-nums text-amber-300">{score(breakdown.applied_penalty)}</div>
        </div>
        <span aria-hidden="true" className="text-sm font-semibold text-zinc-500">=</span>
        <div>
          <div className="text-[11px] text-zinc-500">{copy.final}</div>
          <div className="mt-0.5 text-base font-bold tabular-nums text-zinc-100">{score(finalScore)}</div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] leading-4 text-zinc-400">{copy.note}</p>

      {breakdown.red_flags.length > 0 ? (
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="mb-1.5 text-[11px] font-semibold text-zinc-300">{copy.riskHeading}</div>
          <RiskRows flags={visibleFlags} flagLabel={flagLabel} />
          {remainingFlags.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-amber-300 hover:text-amber-200">
                {copy.more}
              </summary>
              <div className="mt-2">
                <RiskRows flags={remainingFlags} flagLabel={flagLabel} />
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {!breakdown.complete && breakdown.applied_penalty > 0.005 ? (
        <p className="mt-3 rounded-md border border-amber-300/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-4 text-amber-200">
          {copy.unavailable}
        </p>
      ) : null}
      {adjustmentWasLimited ? (
        <p className="mt-2 text-[11px] leading-4 text-zinc-400">{copy.capNote}</p>
      ) : null}
    </div>
  );
}
