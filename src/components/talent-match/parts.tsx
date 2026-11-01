"use client";

import type { ReactNode } from "react";
import { Check, Loader2, ShieldCheck, UserPen } from "lucide-react";
import { barColor } from "@/lib/dimensions";
import type { EvidenceSource, MatchBreakdown, Text } from "@/lib/talent-match/types";

/** Inline zh/en copy, matching the résumé builder's prototype convention. */
export type Copy = {
  c: (zh: string, en: string) => string;
  tx: (text: Text) => string;
  zh: boolean;
};

export function makeCopy(zh: boolean): Copy {
  return { zh, c: (cn, en) => (zh ? cn : en), tx: (text) => (zh ? text.zh : text.en) };
}

export function Card({ title, aside, children, className = "" }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.02] p-5 ${className}`}>
      {(title || aside) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function SourceBadge({ source, copy }: { source: EvidenceSource; copy: Copy }) {
  return source === "verified" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      {copy.c("GitHub 已验证", "Verified")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
      <UserPen className="h-3 w-3" aria-hidden="true" />
      {copy.c("自述", "Claimed")}
    </span>
  );
}

export function fitTone(fit: number): string {
  if (fit >= 75) return "text-emerald-300";
  if (fit >= 55) return "text-amber-300";
  return "text-rose-400";
}

export function FitScore({ fit, label }: { fit: number; label: string }) {
  return (
    <div className="flex shrink-0 flex-col items-end">
      <span className={`text-3xl font-black tabular-nums leading-none ${fitTone(fit)}`}>{fit}</span>
      <span className="mt-1 text-[11px] text-zinc-500">{label}</span>
    </div>
  );
}

export function Bar({ pct }: { pct: number }) {
  const ratio = Math.max(0, Math.min(1, pct));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <div className={`h-full rounded-full ${barColor(ratio)}`} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Breakdown({ breakdown, copy }: { breakdown: MatchBreakdown; copy: Copy }) {
  const rows: [string, number][] = [
    [copy.c("必备要求", "Must-have"), breakdown.mustHave],
    [copy.c("加分项", "Nice-to-have"), breakdown.niceToHave],
    [copy.c("硬条件", "Conditions"), breakdown.conditions],
  ];
  return (
    <dl className="grid gap-2 sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <div className="mb-1 flex justify-between text-xs">
            <dt className="text-zinc-500">{label}</dt>
            <dd className="tabular-nums text-zinc-300">{value}</dd>
          </div>
          <Bar pct={value / 100} />
        </div>
      ))}
    </dl>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "gap" }) {
  const cls =
    tone === "good"
      ? "border-emerald-400/30 text-emerald-300"
      : tone === "gap"
        ? "border-orange-400/30 text-orange-300"
        : "border-white/10 text-zinc-300";
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${cls}`}>{children}</span>;
}

/** Pipeline progress list: done stages get a check, the current one spins. */
export function StageProgress({ stages, current }: { stages: string[]; current: number }) {
  return (
    <ol className="space-y-3" aria-live="polite">
      {stages.map((label, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={label} className={`flex items-center gap-3 text-sm ${state === "todo" ? "text-zinc-500" : "text-zinc-200"}`}>
            <span className={`flex h-6 w-6 items-center justify-center rounded-full border ${state === "done" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" : "border-white/10"}`}>
              {state === "done" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : state === "active" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <span className="h-1.5 w-1.5 rounded-full bg-white/10" />}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

export const primaryButton =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButton =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/5 hover:text-zinc-200";

export const fieldClass =
  "w-full rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-white/20";
