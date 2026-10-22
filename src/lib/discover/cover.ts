/** Deterministic gradient cover from repo identity — no third-party photos. */
export function coverHue(repoKey: string): number {
  let hash = 2166136261;
  for (let i = 0; i < repoKey.length; i += 1) {
    hash ^= repoKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

export function coverStyle(repoKey: string): { background: string } {
  const hue = coverHue(repoKey);
  return {
    background: `linear-gradient(145deg, hsl(${hue} 42% 32%), hsl(${(hue + 38) % 360} 48% 16%))`,
  };
}

export function coverMonogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "gh";
  return trimmed.slice(0, 2);
}
