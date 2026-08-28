import assets from "@/generated/embedded-assets.json";
import type { TierAvatarFrameIcon } from "./tier";

// SVGs ship base64-embedded (scripts/gen-embedded-assets.mts) — no runtime
// filesystem on Workers. Kept async so call sites stay unchanged.
export function tierAvatarFrameIconDataUrl(icon: TierAvatarFrameIcon): Promise<string> {
  return Promise.resolve((assets.tierEmoji as Record<string, string>)[icon] ?? "");
}
