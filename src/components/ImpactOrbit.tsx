"use client";

import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { ImpactRepo, Tier } from "@/lib/types";
import { tierAvatarFrame, tierStyle } from "@/lib/tier";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type ImpactOrbitRepo = Pick<ImpactRepo, "repo" | "stars" | "commits" | "prs">;

function planetSizePx(stars: number): number {
  if (stars >= 100_000) return 30;
  if (stars >= 10_000) return 24;
  return 18;
}

function repoOwner(repo: string): string {
  const slash = repo.indexOf("/");
  return slash > 0 ? repo.slice(0, slash) : repo;
}

function ownerInitial(owner: string): string {
  const ch = owner.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

function activityParts(
  repo: ImpactOrbitRepo,
  commitsLabel: string,
  prsLabel: string,
  formatCount: (n: number) => string,
): string {
  const bits: string[] = [];
  if (repo.commits > 0) bits.push(`${formatCount(repo.commits)} ${commitsLabel}`);
  if (repo.prs > 0) bits.push(`${formatCount(repo.prs)} ${prsLabel}`);
  return bits.join(" · ");
}

function planetAriaLabel(
  repo: ImpactOrbitRepo,
  commitsLabel: string,
  prsLabel: string,
  formatCount: (n: number) => string,
): string {
  const activity = activityParts(repo, commitsLabel, prsLabel, formatCount);
  const stars = `★ ${formatCount(repo.stars)}`;
  return activity ? `${repo.repo}, ${stars}, ${activity}` : `${repo.repo}, ${stars}`;
}

function PlanetAvatar({
  owner,
  size,
  glow,
}: {
  owner: string;
  size: number;
  glow: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = ownerInitial(owner);

  return (
    <span
      className="relative block overflow-hidden rounded-full bg-zinc-800 ring-1 ring-black/70"
      style={{
        width: size,
        height: size,
        boxShadow: `0 0 0 1.5px ${glow}`,
      }}
    >
      {!failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://github.com/${encodeURIComponent(owner)}.png?size=64`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center bg-white/10 font-bold text-zinc-100"
          style={{ fontSize: Math.max(9, Math.round(size * 0.45)) }}
          aria-hidden
        >
          {initial}
        </span>
      )}
    </span>
  );
}

function PlanetTooltipBody({
  repo,
  formatStars,
  activity,
}: {
  repo: ImpactOrbitRepo;
  formatStars: (n: number) => string;
  activity: string;
}) {
  return (
    <>
      <div className="text-xs font-semibold text-zinc-100">{repo.repo}</div>
      <div className="mt-0.5 text-[11px] tabular-nums text-zinc-400">
        ⭐ {formatStars(repo.stars)}
        {activity ? <span className="ms-1.5 text-zinc-500">{activity}</span> : null}
      </div>
    </>
  );
}

function PlanetNode({
  repo,
  angleDeg,
  glow,
  formatStars,
  formatCount,
  commitsLabel,
  prsLabel,
  open,
  onOpenChange,
  armed,
  onArm,
}: {
  repo: ImpactOrbitRepo;
  angleDeg: number;
  glow: string;
  formatStars: (n: number) => string;
  formatCount: (n: number) => string;
  commitsLabel: string;
  prsLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  armed: boolean;
  onArm: () => void;
}) {
  const owner = repoOwner(repo.repo);
  const size = planetSizePx(repo.stars);
  const activity = activityParts(repo, commitsLabel, prsLabel, formatCount);
  const label = planetAriaLabel(repo, commitsLabel, prsLabel, formatCount);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (typeof window === "undefined") return;
      if (!window.matchMedia("(pointer: coarse)").matches) return;
      if (!armed) {
        event.preventDefault();
        onArm();
        onOpenChange(true);
      }
    },
    [armed, onArm, onOpenChange],
  );

  return (
    <div
      className="impact-orbit-planet absolute left-1/2 top-1/2"
      style={{
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        transform: `rotate(${angleDeg}deg) translateY(calc(-1 * var(--impact-orbit-radius)))`,
      }}
    >
      <div
        className="impact-orbit-planet-spin flex h-full w-full items-center justify-center"
        style={{ ["--impact-orbit-angle" as string]: `${angleDeg}deg` }}
      >
        <Tooltip open={open} onOpenChange={onOpenChange}>
          <TooltipTrigger asChild>
            <a
              href={`https://github.com/${repo.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={label}
              className="block rounded-full outline-none transition-transform hover:scale-110 focus-visible:scale-110 focus-visible:ring-2 focus-visible:ring-white/40"
              onClick={handleClick}
            >
              <PlanetAvatar owner={owner} size={size} glow={glow} />
            </a>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="max-w-[16rem] border-white/15 bg-zinc-950/95 px-2.5 py-1.5 text-zinc-100 shadow-lg"
          >
            <PlanetTooltipBody repo={repo} formatStars={formatStars} activity={activity} />
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function CompactPlanetRow({
  repos,
  glow,
  formatStars,
  formatCount,
  commitsLabel,
  prsLabel,
  openRepo,
  setOpenRepo,
  armedRepo,
  setArmedRepo,
}: {
  repos: ImpactOrbitRepo[];
  glow: string;
  formatStars: (n: number) => string;
  formatCount: (n: number) => string;
  commitsLabel: string;
  prsLabel: string;
  openRepo: string | null;
  setOpenRepo: (repo: string | null) => void;
  armedRepo: string | null;
  setArmedRepo: (repo: string | null) => void;
}) {
  return (
    <div
      className="impact-orbit-compact mt-3 flex max-w-full flex-wrap items-center justify-center gap-2"
      data-testid="impact-orbit-compact"
    >
      {repos.map((repo) => {
        const owner = repoOwner(repo.repo);
        const size = planetSizePx(repo.stars);
        const activity = activityParts(repo, commitsLabel, prsLabel, formatCount);
        const label = planetAriaLabel(repo, commitsLabel, prsLabel, formatCount);
        return (
          <Tooltip
            key={repo.repo}
            open={openRepo === repo.repo}
            onOpenChange={(next) => {
              setOpenRepo(next ? repo.repo : null);
              if (!next && armedRepo === repo.repo) setArmedRepo(null);
            }}
          >
            <TooltipTrigger asChild>
              <a
                href={`https://github.com/${repo.repo}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="rounded-full outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-white/40"
                onClick={(event) => {
                  if (typeof window === "undefined") return;
                  if (!window.matchMedia("(pointer: coarse)").matches) return;
                  if (armedRepo !== repo.repo) {
                    event.preventDefault();
                    setArmedRepo(repo.repo);
                    setOpenRepo(repo.repo);
                  }
                }}
              >
                <PlanetAvatar owner={owner} size={size} glow={glow} />
              </a>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[16rem] border-white/15 bg-zinc-950/95 px-2.5 py-1.5 text-zinc-100 shadow-lg"
            >
              <PlanetTooltipBody repo={repo} formatStars={formatStars} activity={activity} />
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function ImpactOrbit({
  repos,
  tier,
  locale,
  commitsLabel,
  prsLabel,
  sectionTitle,
  children,
  className = "",
}: {
  repos: ImpactOrbitRepo[];
  tier: Tier;
  /** BCP 47 tag for compact number formatting (e.g. zh-CN → 16万). */
  locale: string;
  commitsLabel: string;
  prsLabel: string;
  sectionTitle: string;
  children: ReactNode;
  className?: string;
}) {
  const ordered = useMemo(
    () => [...repos].toSorted((a, b) => b.stars - a.stars).slice(0, 6),
    [repos],
  );
  const formatStars = useMemo(() => {
    const nf = new Intl.NumberFormat(locale, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    return (n: number) => nf.format(n);
  }, [locale]);
  const frame = tierAvatarFrame(tier);
  const style = tierStyle(tier);
  const glow = frame.glow;
  const accent = style.glow;
  const countFmt = formatStars;

  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const [armedRepo, setArmedRepo] = useState<string | null>(null);

  if (ordered.length === 0) {
    return <div className={className}>{children}</div>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className={`impact-orbit-root flex flex-col items-center ${className}`} data-testid="impact-orbit-root">
        <h2 className="sr-only">{sectionTitle}</h2>

        {/* Avatar once; orbit ring overlays on wide viewports only. */}
        <div
          className="impact-orbit-stage relative flex items-center justify-center"
          data-testid="impact-orbit-stage"
          style={{
            ["--impact-orbit-size" as string]: "200px",
            ["--impact-orbit-radius" as string]: "82px",
          }}
        >
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 hidden rounded-full border min-[400px]:block"
            style={{
              width: "calc(var(--impact-orbit-radius) * 2)",
              height: "calc(var(--impact-orbit-radius) * 2)",
              marginLeft: "calc(var(--impact-orbit-radius) * -1)",
              marginTop: "calc(var(--impact-orbit-radius) * -1)",
              borderColor: accent,
              opacity: 0.28,
            }}
            aria-hidden
          />

          <div
            className="impact-orbit-spin absolute inset-0 hidden min-[400px]:block"
            data-testid="impact-orbit-spin"
          >
            {ordered.map((repo, index) => {
              const angleDeg = (360 / ordered.length) * index;
              return (
                <PlanetNode
                  key={repo.repo}
                  repo={repo}
                  angleDeg={angleDeg}
                  glow={glow}
                  formatStars={formatStars}
                  formatCount={countFmt}
                  commitsLabel={commitsLabel}
                  prsLabel={prsLabel}
                  open={openRepo === repo.repo}
                  onOpenChange={(next) => {
                    setOpenRepo(next ? repo.repo : null);
                    if (!next && armedRepo === repo.repo) setArmedRepo(null);
                  }}
                  armed={armedRepo === repo.repo}
                  onArm={() => setArmedRepo(repo.repo)}
                />
              );
            })}
          </div>

          <div className="relative z-[1] flex items-center justify-center">{children}</div>
        </div>

        {/* Narrow viewports (~390px): compact planet row under the avatar. */}
        <div className="min-[400px]:hidden" data-testid="impact-orbit-narrow">
          <CompactPlanetRow
            repos={ordered}
            glow={glow}
            formatStars={formatStars}
            formatCount={countFmt}
            commitsLabel={commitsLabel}
            prsLabel={prsLabel}
            openRepo={openRepo}
            setOpenRepo={setOpenRepo}
            armedRepo={armedRepo}
            setArmedRepo={setArmedRepo}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

/** Shared list-row class for the Featured-work disclosure (matches prior card rows). */
export function impactRepoRowClassName(): string {
  return "flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]";
}
