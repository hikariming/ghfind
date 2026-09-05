"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type LeaderboardRailTab = {
  key: string;
  label: string;
  panel: ReactNode;
};

/**
 * Tab switcher for the homepage leaderboard rail. Every board arrives as a
 * server-rendered panel — the only client state is which one is visible, so
 * switching tabs never fetches (the homepage shell stays force-static and no
 * function/DB traffic is added per click). Chip styling mirrors
 * LeaderboardControls so the rail reads as a mini /leaderboard.
 */
export function LeaderboardRailTabs({ tabs }: { tabs: LeaderboardRailTab[] }) {
  const [active, setActive] = useState(tabs[0]?.key);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActive(tab.key)}
            aria-pressed={active === tab.key}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              active === tab.key
                ? "border-border bg-accent text-accent-foreground"
                : "border-white/10 bg-white/[0.02] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.key} hidden={active !== tab.key}>
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
