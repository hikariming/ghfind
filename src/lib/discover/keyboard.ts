import type { DiscoverAction } from "./types";

export type DiscoverKeyCommand = DiscoverAction | "undo";

export function commandFromKey(key: string): DiscoverKeyCommand | null {
  if (key === "ArrowLeft") return "skip";
  if (key === "ArrowRight") return "like";
  if (key === "ArrowUp") return "superlike";
  if (key === "Backspace") return "undo";
  return null;
}
