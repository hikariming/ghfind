"use client";

import { Link } from "@/i18n/navigation";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export type EvaluatePhase = "fetch" | "analyze" | "roast" | "error" | "timeout";

const PHASE_ORDER: Array<Exclude<EvaluatePhase, "error" | "timeout">> = [
  "fetch",
  "analyze",
  "roast",
];

/**
 * Waiting shell that mirrors PendingProfile's grid (back link, sticky
 * identity column, evidence + roast column) so the scan→profile swap does
 * not jump the layout.
 *
 * Mobile (~360–390 CSS px): equal-width stage grid (EN labels must not wrap
 * into a messy 2+1 flex row), tighter card padding, avatar footprint matched
 * to TierAvatarFrame `lg`, tap-friendly back/retry, safe-area bottom inset.
 */
export function ProfileEvaluateWait({
  username,
  phase,
  stageLabel,
  stageLabels,
  percent,
  backLabel,
  errorLabel,
  retryLabel,
  onRetry,
}: {
  username: string;
  phase: EvaluatePhase;
  stageLabel: string;
  stageLabels: [string, string, string];
  percent: number;
  backLabel: string;
  errorLabel?: string;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  const failed = phase === "error" || phase === "timeout";
  const clamped = Math.min(100, Math.max(0, Math.floor(percent)));
  const activeIdx = phase === "analyze" ? 1 : phase === "roast" ? 2 : 0;

  return (
    <main
      data-profile-evaluate={phase}
      className="relative isolate flex w-full flex-1 justify-center px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom,0px))] sm:px-5 sm:pt-14 sm:pb-14 md:pt-20 md:pb-20"
    >
      <div className="relative z-10 flex w-full max-w-4xl flex-col">
        <Link
          href="/leaderboard"
          className="inline-flex min-h-11 w-fit items-center text-sm text-zinc-400 hover:text-zinc-200"
        >
          {backLabel}
        </Link>

        <div className="mt-3 flex flex-col gap-5 sm:mt-4 sm:gap-6 lg:flex-row lg:items-start">
          {/* Left: identity sidebar — same width / padding as PendingProfile */}
          <aside className="flex flex-col gap-4 lg:sticky lg:top-8 lg:w-80 lg:shrink-0">
            <div className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.05] p-4 text-center ring-1 ring-white/10 sm:p-6">
              {/* Match ProfileView / PendingProfile handle typography; soft surface
                  instead of a heavy black pill while realm colors are unknown. */}
              <h1 className="max-w-full">
                <span className="inline-block max-w-full break-all rounded-full bg-white/[0.05] px-3 py-1.5 text-lg font-black leading-tight text-zinc-100 ring-1 ring-white/15 sm:px-4 sm:text-xl">
                  @{username}
                </span>
              </h1>
              <Skeleton className="mt-2 h-4 w-28 max-w-[70%] rounded-full bg-white/10" />
              <Skeleton className="mt-2 h-8 w-full max-w-[12rem] rounded-lg bg-white/10" />
              {/* TierAvatarFrame size="lg" shell is h-28 w-28 */}
              <Skeleton className="mt-5 size-28 rounded-full bg-white/10" />
              {/* AdventurerLevel lg footprint (caption + text-6xl) */}
              <div className="mt-4 flex w-full flex-col items-center gap-2" aria-hidden>
                <Skeleton className="h-3 w-24 max-w-[60%] rounded-full bg-white/10" />
                <Skeleton className="h-14 w-36 max-w-[80%] rounded-xl bg-white/10" />
              </div>
              <Skeleton className="mt-3 h-8 w-36 max-w-[70%] rounded-full bg-white/10" />
              <Skeleton className="mt-2 h-4 w-44 max-w-[85%] rounded-full bg-white/10" />
            </div>

            {/* Progress / error sits where the live-pending banner will be */}
            <section
              className={`rounded-2xl border p-3.5 sm:p-4 ${
                failed
                  ? "border-white/10 bg-white/[0.04]"
                  : "border-orange-300/30 bg-orange-500/[0.07]"
              }`}
              role="status"
              aria-live="polite"
            >
              <div className="flex flex-col items-center gap-2.5 text-center sm:gap-3">
                {!failed ? (
                  <LoaderCircle
                    aria-hidden
                    className="size-7 text-orange-200/90 motion-safe:animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <RefreshCw aria-hidden className="size-7 text-rose-300/90" />
                )}
                {!failed ? (
                  <div className="flex max-w-full flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5 px-1">
                    <p className="text-sm font-semibold text-balance text-orange-200/90">
                      {stageLabel}
                    </p>
                    <p className="text-xs tabular-nums text-orange-100/70">{clamped}%</p>
                  </div>
                ) : (
                  <p className="max-w-prose text-balance px-1 text-sm font-semibold text-zinc-100">
                    {errorLabel}
                  </p>
                )}
                {!failed ? (
                  <ol className="grid w-full grid-cols-3 gap-1.5">
                    {PHASE_ORDER.map((id, idx) => {
                      const done = idx < activeIdx;
                      const active = idx === activeIdx;
                      return (
                        <li
                          key={id}
                          data-phase={id}
                          data-active={active ? "1" : "0"}
                          title={stageLabels[idx]}
                          className={`min-w-0 rounded-full px-1.5 py-1.5 text-center text-[10px] leading-tight ring-1 sm:px-2.5 sm:text-[11px] ${
                            active
                              ? "bg-orange-500/20 text-orange-100 ring-orange-400/40"
                              : done
                                ? "bg-white/5 text-zinc-300 ring-white/10"
                                : "bg-transparent text-zinc-500 ring-white/5"
                          }`}
                        >
                          <span className="line-clamp-2 break-words">{stageLabels[idx]}</span>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
                {failed && onRetry && retryLabel ? (
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    shape="pill"
                    className="mt-1 min-h-11 gap-1.5 bg-orange-600 px-5 text-white hover:bg-orange-500"
                    onClick={onRetry}
                  >
                    <RefreshCw aria-hidden className="size-3.5" />
                    {retryLabel}
                  </Button>
                ) : null}
              </div>
            </section>
          </aside>

          {/* Right: evidence + roast placeholders matching PendingProfile sections */}
          <div className="flex min-w-0 flex-1 flex-col">
            <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5 md:p-6" aria-hidden>
              <Skeleton className="mb-4 h-4 w-32 max-w-[50%] bg-white/10" />
              <div className="mx-auto aspect-square w-full max-w-[16rem] rounded-full bg-white/[0.04] ring-1 ring-white/10 sm:max-w-xs" />
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Skeleton className="h-8 rounded-lg bg-white/10" />
                <Skeleton className="h-8 rounded-lg bg-white/10" />
                <Skeleton className="h-8 rounded-lg bg-white/10" />
                <Skeleton className="h-8 rounded-lg bg-white/10" />
                <Skeleton className="h-8 rounded-lg bg-white/10" />
                <Skeleton className="h-8 rounded-lg bg-white/10" />
              </div>
            </section>

            <section className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:mt-6 sm:p-5 md:p-6" aria-hidden>
              <Skeleton className="mb-1 h-4 w-28 max-w-[45%] bg-white/10" />
              <Skeleton className="mb-4 h-3 w-48 max-w-[70%] bg-white/10" />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Skeleton className="h-20 rounded-xl bg-white/10" />
                <Skeleton className="h-20 rounded-xl bg-white/10" />
                <Skeleton className="h-20 rounded-xl bg-white/10" />
                <Skeleton className="h-20 rounded-xl bg-white/10" />
              </div>
            </section>

            <section className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:mt-6 sm:p-5 md:p-7" aria-hidden>
              <div className="roast-progress-shimmer space-y-2 motion-reduce:[&_*]:animate-none">
                <div className="h-3 w-40 max-w-[55%] rounded-full bg-foreground/10" />
                <div className="h-2 w-11/12 rounded-full bg-foreground/10" />
                <div className="h-2 w-9/12 rounded-full bg-foreground/10" />
                <div className="h-2 w-7/12 rounded-full bg-foreground/10" />
                <div className="h-2 w-8/12 rounded-full bg-foreground/10" />
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
