import { Link } from "@/i18n/navigation";
import type { LeaderboardWindow } from "@/lib/leaderboardWindow";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { LeaderboardView } from "./LeaderboardClient";

type LeaderboardControlItem<T extends string> = {
  key: T;
  label: string;
  active: boolean;
  href?: string;
  onSelect?: () => void;
};

type LeaderboardControlsProps = {
  viewItems: LeaderboardControlItem<LeaderboardView>[];
  windowItems: LeaderboardControlItem<LeaderboardWindow>[];
  windowAriaLabel: string;
  action?: React.ReactNode;
  frame?: "flat" | "panel";
  className?: string;
};

function LeaderboardControlChip<T extends string>({
  item,
  size,
}: {
  item: LeaderboardControlItem<T>;
  size: "view" | "window";
}) {
  const className = cn(
    "shrink-0 whitespace-nowrap rounded-full border text-center transition-colors",
    size === "view" ? "px-3 py-1.5 text-sm font-medium" : "px-3 py-1 text-xs font-medium",
    item.active
      ? "border-orange-500/30 bg-orange-500/10 text-orange-200"
      : "border-white/10 bg-white/[0.02] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200",
  );

  if (item.href) {
    return (
      <Link href={item.href} aria-current={item.active ? "page" : undefined} className={className}>
        {item.label}
      </Link>
    );
  }

  return (
    <Button
      type="button"
      onClick={item.onSelect}
      variant="ghost"
      size="sm"
      aria-pressed={item.active}
      className={className}
    >
      {item.label}
    </Button>
  );
}

export function LeaderboardControls({
  viewItems,
  windowItems,
  windowAriaLabel,
  action,
  frame = "flat",
  className,
}: LeaderboardControlsProps) {
  return (
    <div
      className={cn(
        frame === "panel" &&
          "rounded-2xl border border-white/10 bg-white/[0.02] p-3 shadow-sm sm:p-4",
        className,
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-3",
          action && "sm:flex-row sm:items-start sm:justify-between",
        )}
      >
        <div className="flex w-full flex-wrap items-center gap-2">
          {viewItems.map((item) => (
            <LeaderboardControlChip key={item.key} item={item} size="view" />
          ))}
        </div>
        {action ? (
          <div className="flex w-full justify-end sm:w-auto sm:shrink-0 sm:self-auto">
            {action}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {action ? (
          <div className="sm:hidden">
            <div className="h-px bg-white/10" />
          </div>
        ) : null}
        <div
          role="group"
          aria-label={windowAriaLabel}
          className="flex w-full flex-wrap items-center gap-2"
        >
          {windowItems.map((item) => (
            <LeaderboardControlChip key={item.key} item={item} size="window" />
          ))}
        </div>
      </div>
    </div>
  );
}
