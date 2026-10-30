import { BookOpen, Briefcase, FolderGit2, Library, MessageSquareQuote, UserRound, Users, type LucideIcon } from "lucide-react";
import { tierAvatarFrame, tierAvatarFrameIconPath } from "@/lib/tier";
import type { Tier } from "@/lib/types";
import type { StreamKind } from "@/lib/stream/types";

/** Per-kind accent. The *-300 text classes have light-theme mappings in globals.css. */
export const KIND_STYLE: Record<StreamKind, { icon: LucideIcon; text: string; tint: string; tile: string }> = {
  project: { icon: FolderGit2, text: "text-orange-300", tint: "bg-orange-500/10", tile: "from-orange-500/25 via-orange-500/5" },
  developer: { icon: UserRound, text: "text-violet-300", tint: "bg-violet-500/10", tile: "from-violet-500/25 via-violet-500/5" },
  talent: { icon: Users, text: "text-emerald-300", tint: "bg-emerald-500/10", tile: "from-emerald-500/25 via-emerald-500/5" },
  article: { icon: BookOpen, text: "text-sky-300", tint: "bg-sky-500/10", tile: "from-sky-500/25 via-sky-500/5" },
  collection: { icon: Library, text: "text-amber-300", tint: "bg-amber-500/10", tile: "from-amber-500/25 via-amber-500/5" },
  job: { icon: Briefcase, text: "text-rose-400", tint: "bg-rose-500/10", tile: "from-rose-500/25 via-rose-500/5" },
  // Neutral, like X's own black/white mark.
  post: { icon: MessageSquareQuote, text: "text-foreground", tint: "bg-foreground/10", tile: "from-foreground/15 via-foreground/5" },
};

const TIER_BY_KEY: Record<string, Tier> = { god: "夯", elite: "顶级", solid: "人上人", npc: "NPC", trash: "拉完了" };

export function isTierKey(label: string | null): label is string {
  return label != null && label in TIER_BY_KEY;
}

/** The site's tier badge artwork (public/tier-emoji), same as the avatar frames. */
export function tierIconSrc(key: string): string {
  return tierAvatarFrameIconPath(tierAvatarFrame(TIER_BY_KEY[key] ?? "NPC").icon);
}

export function compactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** "3h", "2d"… relative to a fixed `now` so server and client render the same text. */
export function relativeTime(iso: string, now: number, locale: string): string {
  const diff = Date.parse(iso) - now;
  if (!Number.isFinite(diff)) return "";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(Math.min(-1, minutes), "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return rtf.format(months, "month");
  return rtf.format(Math.round(months / 12), "year");
}

export function initials(name: string): string {
  return name.replace(/^@/, "").slice(0, 1).toUpperCase();
}
