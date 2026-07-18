import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TierAvatarFrameIcon } from "./tier";

const iconDataUrls = new Map<TierAvatarFrameIcon, Promise<string>>();

export function tierAvatarFrameIconDataUrl(icon: TierAvatarFrameIcon): Promise<string> {
  const cached = iconDataUrls.get(icon);
  if (cached) return cached;

  const dataUrl = readFile(path.join(process.cwd(), "public", "tier-emoji", `${icon}.svg`)).then(
    (svg) => `data:image/svg+xml;base64,${svg.toString("base64")}`,
  );
  iconDataUrls.set(icon, dataUrl);
  return dataUrl;
}
