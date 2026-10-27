"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { ImpactRepo, Tier } from "@/lib/types";
import { tierAvatarFrame, tierStyle } from "@/lib/tier";

export type ImpactOrbitRepo = Pick<ImpactRepo, "repo" | "stars" | "commits" | "prs">;

type OrbitDef = {
  id: string;
  rx: number;
  ry: number;
  rotateX: number;
  rotateZ: number;
  periodMs: number;
};

/** Inner / mid / outer — higher-star repos prefer the inner track. */
const ORBITS: OrbitDef[] = [
  { id: "inner", rx: 72, ry: 30, rotateX: 68, rotateZ: -18, periodMs: 40_000 },
  { id: "mid", rx: 90, ry: 36, rotateX: 70, rotateZ: 12, periodMs: 60_000 },
  { id: "outer", rx: 108, ry: 40, rotateX: 72, rotateZ: 30, periodMs: 80_000 },
];

const PERSPECTIVE = 800;
const STAGE_SIZE = 220;

type PlacedPlanet = ImpactOrbitRepo & {
  owner: string;
  orbitIndex: number;
  phase: number;
  sizePx: number;
};

type Projected = {
  x: number;
  y: number;
  depthScale: number;
  opacity: number;
  blur: number;
  zIndex: number;
};

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

function withAlpha(color: string, alpha: number): string {
  const match = color.match(
    /rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+\s*)?\)/,
  );
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
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

/** Assign higher-star repos to inner orbits; spread phases within each track. */
function placePlanets(repos: ImpactOrbitRepo[]): PlacedPlanet[] {
  const ordered = [...repos].toSorted((a, b) => b.stars - a.stars).slice(0, 6);
  const buckets: ImpactOrbitRepo[][] = [[], [], []];
  ordered.forEach((repo, i) => {
    const orbitIndex = Math.min(2, Math.floor(i / 2));
    buckets[orbitIndex].push(repo);
  });
  const placed: PlacedPlanet[] = [];
  buckets.forEach((bucket, orbitIndex) => {
    const n = bucket.length;
    bucket.forEach((repo, i) => {
      placed.push({
        ...repo,
        owner: repoOwner(repo.repo),
        orbitIndex,
        phase: n === 0 ? 0 : i / n + orbitIndex * 0.07,
        sizePx: planetSizePx(repo.stars),
      });
    });
  });
  return placed;
}

function projectPlanet(planet: PlacedPlanet, elapsedMs: number, frozen: boolean): Projected {
  const orbit = ORBITS[planet.orbitIndex] ?? ORBITS[0];
  const turn = frozen
    ? planet.phase
    : ((elapsedMs / orbit.periodMs + planet.phase) % 1 + 1) % 1;
  const angle = turn * Math.PI * 2;

  let x = orbit.rx * Math.cos(angle);
  let y = orbit.ry * Math.sin(angle);
  const z = 0;

  const rz = (orbit.rotateZ * Math.PI) / 180;
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const x1 = x * cz - y * sz;
  const y1 = x * sz + y * cz;

  const rx = (orbit.rotateX * Math.PI) / 180;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const y2 = y1 * cx - z * sx;
  const z2 = y1 * sx + z * cx;

  const scale3d = PERSPECTIVE / (PERSPECTIVE - z2);
  const screenX = x1 * scale3d;
  const screenY = y2 * scale3d;

  const zAmp = Math.max(1, orbit.ry * Math.sin(rx));
  const depthNorm = Math.max(-1, Math.min(1, z2 / zAmp));
  const frontness = (depthNorm + 1) / 2;
  const backness = 1 - frontness;

  return {
    x: screenX,
    y: screenY,
    depthScale: 0.7 + frontness * 0.4,
    opacity: 0.45 + frontness * 0.55,
    blur: backness * 1.25,
    zIndex: Math.round(5 + frontness * 30),
  };
}

function orbitPathPoints(orbit: OrbitDef, samples = 72): { x: number; y: number; back: boolean }[] {
  const pts: { x: number; y: number; back: boolean }[] = [];
  const rz = (orbit.rotateZ * Math.PI) / 180;
  const rx = (orbit.rotateX * Math.PI) / 180;
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const zAmp = Math.max(1, orbit.ry * Math.sin(rx));

  for (let i = 0; i <= samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    const x = orbit.rx * Math.cos(angle);
    const y = orbit.ry * Math.sin(angle);
    const x1 = x * cz - y * sz;
    const y1 = x * sz + y * cz;
    const y2 = y1 * cx;
    const z2 = y1 * sx;
    const scale3d = PERSPECTIVE / (PERSPECTIVE - z2);
    const depthNorm = Math.max(-1, Math.min(1, z2 / zAmp));
    pts.push({
      x: x1 * scale3d,
      y: y2 * scale3d,
      back: depthNorm < 0,
    });
  }
  return pts;
}

function splitOrbitPaths(orbit: OrbitDef): { front: string; back: string } {
  const pts = orbitPathPoints(orbit);
  const toD = (slice: { x: number; y: number }[]) => {
    if (slice.length === 0) return "";
    return slice
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(" ");
  };

  const frontParts: string[] = [];
  const backParts: string[] = [];
  let run: { x: number; y: number }[] = [];
  let runBack: boolean | null = null;

  const flush = () => {
    if (run.length < 2 || runBack === null) {
      run = [];
      return;
    }
    const d = toD(run);
    if (runBack) backParts.push(d);
    else frontParts.push(d);
    run = [];
  };

  for (const p of pts) {
    if (runBack === null) {
      runBack = p.back;
      run.push(p);
      continue;
    }
    if (p.back === runBack) {
      run.push(p);
    } else {
      run.push(p);
      flush();
      runBack = p.back;
      run.push(p);
    }
  }
  flush();

  return { front: frontParts.join(" "), back: backParts.join(" ") };
}

function PlanetAvatar({
  owner,
  size,
  accent,
  glow,
}: {
  owner: string;
  size: number;
  accent: string;
  glow: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      className="relative block overflow-hidden rounded-full bg-zinc-800"
      style={{
        width: size,
        height: size,
        border: `1px solid ${withAlpha(accent, 0.9)}`,
        boxShadow: `0 0 0 1px ${withAlpha(glow, 0.35)}, 0 0 12px ${withAlpha(glow, 0.55)}`,
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
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center bg-white/10 font-bold text-zinc-100"
          style={{ fontSize: Math.max(9, Math.round(size * 0.45)) }}
          aria-hidden
        >
          {ownerInitial(owner)}
        </span>
      )}
    </span>
  );
}

function FrostCard({
  repo,
  formatStars,
  activity,
  surface,
  accent,
  shift,
}: {
  repo: ImpactOrbitRepo;
  formatStars: (n: number) => string;
  activity: string;
  surface: string;
  accent: string;
  shift: { x: number; y: number };
}) {
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left shadow-lg"
      data-testid="impact-orbit-frost"
      style={{
        background: withAlpha(surface, 0.6),
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: `1px solid ${withAlpha(accent, 0.65)}`,
        minWidth: "max-content",
        transform: `translate(${shift.x}px, ${shift.y}px)`,
      }}
      role="tooltip"
    >
      <div className="text-xs font-semibold text-zinc-100">{repo.repo}</div>
      <div className="mt-0.5 whitespace-nowrap text-[11px] tabular-nums text-zinc-200">
        ⭐ {formatStars(repo.stars)}
        {activity ? <span className="ms-1.5 text-zinc-300">{activity}</span> : null}
      </div>
    </div>
  );
}

function CompactPlanetRow({
  repos,
  accent,
  glow,
  surface,
  formatStars,
  formatCount,
  commitsLabel,
  prsLabel,
  activeRepo,
  setActiveRepo,
  armedRepo,
  setArmedRepo,
}: {
  repos: PlacedPlanet[];
  accent: string;
  glow: string;
  surface: string;
  formatStars: (n: number) => string;
  formatCount: (n: number) => string;
  commitsLabel: string;
  prsLabel: string;
  activeRepo: string | null;
  setActiveRepo: (repo: string | null) => void;
  armedRepo: string | null;
  setArmedRepo: (repo: string | null) => void;
}) {
  return (
    <div
      className="impact-orbit-compact mt-3 flex max-w-full flex-wrap items-center justify-center gap-2"
      data-testid="impact-orbit-compact"
    >
      {repos.map((repo) => {
        const activity = activityParts(repo, commitsLabel, prsLabel, formatCount);
        const label = planetAriaLabel(repo, commitsLabel, prsLabel, formatCount);
        const active = activeRepo === repo.repo;
        return (
          <div key={repo.repo} className="relative">
            <a
              href={`https://github.com/${repo.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={label}
              className="relative block rounded-full outline-none transition-transform hover:scale-125 focus-visible:scale-125 focus-visible:ring-2 focus-visible:ring-white/40"
              onMouseEnter={() => setActiveRepo(repo.repo)}
              onMouseLeave={() => setActiveRepo(null)}
              onFocus={() => setActiveRepo(repo.repo)}
              onBlur={() => setActiveRepo(null)}
              onClick={(event) => {
                if (typeof window === "undefined") return;
                if (!window.matchMedia("(pointer: coarse)").matches) return;
                if (armedRepo !== repo.repo) {
                  event.preventDefault();
                  setArmedRepo(repo.repo);
                  setActiveRepo(repo.repo);
                }
              }}
            >
              <PlanetAvatar owner={repo.owner} size={repo.sizePx} accent={accent} glow={glow} />
            </a>
            {active ? (
              <FrostCard
                repo={repo}
                formatStars={formatStars}
                activity={activity}
                surface={surface}
                accent={accent}
                shift={{ x: 0, y: 0 }}
              />
            ) : null}
          </div>
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
  locale: string;
  commitsLabel: string;
  prsLabel: string;
  sectionTitle: string;
  children: ReactNode;
  className?: string;
}) {
  const placed = useMemo(() => placePlanets(repos), [repos]);
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
  // Frosted card surface: tier glow at ~0.6 alpha (withAlpha applied in card).
  const surface = accent;

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const planetEls = useRef(new Map<string, HTMLDivElement>());
  const lastProj = useRef(new Map<string, Projected>());
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const pauseElapsedRef = useRef(0);
  const pausedRef = useRef(false);
  const visibleRef = useRef(true);
  const reducedRef = useRef(false);

  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [armedRepo, setArmedRepo] = useState<string | null>(null);
  const [cardShift, setCardShift] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const orbitPaths = useMemo(
    () => ORBITS.map((orbit) => ({ id: orbit.id, ...splitOrbitPaths(orbit) })),
    [],
  );

  const applyPlanetStyle = useCallback(
    (key: string, proj: Projected, hovered: boolean) => {
      const el = planetEls.current.get(key);
      if (!el) return;
      const scale = proj.depthScale * (hovered ? 1.6 : 1);
      el.style.transform = `translate(-50%, -50%) translate3d(${proj.x}px, ${proj.y}px, 0) scale(${scale})`;
      el.style.opacity = String(hovered ? 1 : proj.opacity);
      el.style.filter = hovered || proj.blur < 0.05 ? "none" : `blur(${proj.blur}px)`;
      el.style.zIndex = String(hovered ? 60 : proj.zIndex);
      lastProj.current.set(key, proj);
    },
    [],
  );

  const paint = useCallback(
    (elapsedMs: number, frozen: boolean) => {
      for (const planet of placed) {
        const proj = projectPlanet(planet, elapsedMs, frozen);
        applyPlanetStyle(planet.repo, proj, activeRepo === planet.repo);
      }
    },
    [placed, applyPlanetStyle, activeRepo],
  );

  const tick = useCallback(
    (now: number) => {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      pauseElapsedRef.current = elapsed;
      paint(elapsed, false);
      if (!pausedRef.current && visibleRef.current && !reducedRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    },
    [paint],
  );

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    if (reducedRef.current) {
      paint(0, true);
      return;
    }
    // Resume from frozen elapsed so hover pause doesn't jump.
    if (startRef.current === null) {
      startRef.current = performance.now() - pauseElapsedRef.current;
    } else {
      startRef.current = performance.now() - pauseElapsedRef.current;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [paint, tick]);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    // Initial paint (SSR-safe positions = reduced/frozen phases).
    paint(0, true);
  }, [paint]);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyReduced = () => {
      reducedRef.current = reduced.matches;
      if (reduced.matches) {
        stopLoop();
        paint(0, true);
      } else if (visibleRef.current && !pausedRef.current) {
        startLoop();
      }
    };
    applyReduced();
    reduced.addEventListener("change", applyReduced);

    const root = rootRef.current;
    let io: IntersectionObserver | null = null;
    if (root && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        ([entry]) => {
          visibleRef.current = entry.isIntersecting;
          if (entry.isIntersecting && !pausedRef.current && !reducedRef.current) {
            startLoop();
          } else if (!entry.isIntersecting) {
            stopLoop();
          }
        },
        { rootMargin: "40px", threshold: 0.05 },
      );
      io.observe(root);
    } else if (!reduced.matches) {
      startLoop();
    }

    return () => {
      reduced.removeEventListener("change", applyReduced);
      io?.disconnect();
      stopLoop();
    };
  }, [paint, startLoop, stopLoop]);

  useEffect(() => {
    pausedRef.current = Boolean(activeRepo);
    if (activeRepo) {
      stopLoop();
      // Re-apply with hover scale on the active planet using last projection.
      for (const planet of placed) {
        const proj =
          lastProj.current.get(planet.repo) ??
          projectPlanet(planet, pauseElapsedRef.current, reducedRef.current);
        applyPlanetStyle(planet.repo, proj, planet.repo === activeRepo);
      }
    } else if (visibleRef.current && !reducedRef.current) {
      startLoop();
    } else {
      paint(pauseElapsedRef.current, reducedRef.current);
    }
  }, [activeRepo, placed, applyPlanetStyle, paint, startLoop, stopLoop]);

  // Clamp frost card inside score card; keep clear of the score number.
  useEffect(() => {
    if (!activeRepo || !stageRef.current) {
      setCardShift({ x: 0, y: 0 });
      return;
    }
    const proj = lastProj.current.get(activeRepo);
    const planet = placed.find((p) => p.repo === activeRepo);
    if (!proj || !planet) return;

    const card = rootRef.current?.closest("[data-profile-score-card]") as HTMLElement | null;
    const stage = stageRef.current;
    if (!card) return;

    const cardRect = card.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const scoreEl = card.querySelector("[data-profile-score-value]") as HTMLElement | null;
    const scoreTop = scoreEl
      ? scoreEl.getBoundingClientRect().top
      : cardRect.bottom - 48;

    const tipW = 176;
    const tipH = 48;
    const planetCenterX = stageRect.left + stageRect.width / 2 + proj.x;
    const planetCenterY = stageRect.top + stageRect.height / 2 + proj.y;
    const planetR = (planet.sizePx * proj.depthScale * 1.6) / 2;

    let tipLeft = planetCenterX - tipW / 2;
    let tipTop = planetCenterY + planetR + 6;
    if (tipTop + tipH > scoreTop - 6) {
      tipTop = planetCenterY - planetR - tipH - 6;
    }

    const pad = 8;
    const minX = cardRect.left + pad;
    const maxX = cardRect.right - pad - tipW;
    const minY = cardRect.top + pad;
    const maxY = Math.min(cardRect.bottom - pad - tipH, scoreTop - tipH - 4);

    const clampedLeft = Math.min(Math.max(tipLeft, minX), Math.max(minX, maxX));
    const clampedTop = Math.min(Math.max(tipTop, minY), Math.max(minY, maxY));

    setCardShift({
      x: clampedLeft - tipLeft,
      y: clampedTop - tipTop,
    });
  }, [activeRepo, placed]);

  if (placed.length === 0) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      ref={rootRef}
      className={`impact-orbit-root flex flex-col items-center ${className}`}
      data-testid="impact-orbit-root"
    >
      <h2 className="sr-only">{sectionTitle}</h2>

      <div
        ref={stageRef}
        className="impact-orbit-stage relative hidden items-center justify-center min-[400px]:flex"
        data-testid="impact-orbit-stage"
        style={
          {
            width: STAGE_SIZE,
            height: STAGE_SIZE,
            perspective: `${PERSPECTIVE}px`,
            transformStyle: "preserve-3d",
            "--impact-orbit-size": `${STAGE_SIZE}px`,
          } as CSSProperties
        }
      >
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={STAGE_SIZE}
          height={STAGE_SIZE}
          viewBox={`${-STAGE_SIZE / 2} ${-STAGE_SIZE / 2} ${STAGE_SIZE} ${STAGE_SIZE}`}
          aria-hidden
          data-testid="impact-orbit-rings"
        >
          {orbitPaths.map((path) => (
            <g key={path.id}>
              {path.back ? (
                <path
                  d={path.back}
                  fill="none"
                  stroke={withAlpha(accent, 0.22)}
                  strokeWidth={1}
                  strokeDasharray="3 4"
                />
              ) : null}
              {path.front ? (
                <path
                  d={path.front}
                  fill="none"
                  stroke={withAlpha(accent, 0.28)}
                  strokeWidth={1.1}
                />
              ) : null}
            </g>
          ))}
        </svg>

        <div className="relative z-[20] flex items-center justify-center">{children}</div>

        {placed.map((planet) => {
          const active = activeRepo === planet.repo;
          const activity = activityParts(planet, commitsLabel, prsLabel, formatStars);
          const label = planetAriaLabel(planet, commitsLabel, prsLabel, formatStars);
          return (
            <div
              key={planet.repo}
              ref={(el) => {
                if (el) planetEls.current.set(planet.repo, el);
                else planetEls.current.delete(planet.repo);
              }}
              className="impact-orbit-planet absolute left-1/2 top-1/2 will-change-transform"
              data-testid="impact-orbit-planet"
              style={{
                width: planet.sizePx,
                height: planet.sizePx,
                transform: "translate(-50%, -50%)",
              }}
            >
              <a
                href={`https://github.com/${planet.repo}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label}
                className="relative block rounded-full outline-none transition-transform duration-200 focus-visible:ring-2 focus-visible:ring-white/40"
                onMouseEnter={() => setActiveRepo(planet.repo)}
                onMouseLeave={() => {
                  setActiveRepo(null);
                  setArmedRepo(null);
                }}
                onFocus={() => setActiveRepo(planet.repo)}
                onBlur={() => setActiveRepo(null)}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (typeof window === "undefined") return;
                  if (!window.matchMedia("(pointer: coarse)").matches) return;
                  if (armedRepo !== planet.repo) {
                    event.preventDefault();
                    setArmedRepo(planet.repo);
                    setActiveRepo(planet.repo);
                  }
                }}
                onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) => {
                  if (event.key === "Escape") setActiveRepo(null);
                }}
              >
                <PlanetAvatar
                  owner={planet.owner}
                  size={planet.sizePx}
                  accent={accent}
                  glow={glow}
                />
                {active ? (
                  <FrostCard
                    repo={planet}
                    formatStars={formatStars}
                    activity={activity}
                    surface={surface}
                    accent={accent}
                    shift={cardShift}
                  />
                ) : null}
              </a>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col items-center min-[400px]:hidden" data-testid="impact-orbit-narrow">
        {children}
        <CompactPlanetRow
          repos={placed}
          accent={accent}
          glow={glow}
          surface={surface}
          formatStars={formatStars}
          formatCount={formatStars}
          commitsLabel={commitsLabel}
          prsLabel={prsLabel}
          activeRepo={activeRepo}
          setActiveRepo={setActiveRepo}
          armedRepo={armedRepo}
          setArmedRepo={setArmedRepo}
        />
      </div>
    </div>
  );
}
