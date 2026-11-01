"use client";
import { useState } from "react";
import { TierAvatarFrame } from "@/components/TierAvatarFrame";
import { tierFor } from "@/lib/score-presentation";
import { cn } from "@/lib/utils";

export function FeedAvatar({ name, src, score, size = "feed" }: { name: string; src: string | null; score?: number | null; size?: "feed" | "sm" }) {
  const [loaded, setLoaded] = useState(false);
  const avatar = <span className="relative inline-flex size-full shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-semibold text-muted-foreground">
    <span aria-hidden>{Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}</span>
    {/* eslint-disable-next-line @next/next/no-img-element -- remote avatar in the shared Astro island, with deterministic local fallback */}
    {src ? <img src={src} alt="" loading="lazy" onLoad={() => setLoaded(true)} onError={() => setLoaded(false)} className={cn("absolute inset-0 size-full object-cover", !loaded && "opacity-0")} /> : null}
  </span>;
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100
    ? <TierAvatarFrame username={name} avatarUrl={src} avatarContent={avatar} tier={tierFor(score).tier} size={size} />
    : <span className={cn("inline-flex shrink-0", size === "sm" ? "size-16" : "size-10")}>{avatar}</span>;
}

