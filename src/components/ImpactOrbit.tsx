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
import { realmForScore, realmForTier } from "@/lib/realm";

export type ImpactOrbitRepo = Pick<ImpactRepo, "repo" | "stars" | "commits" | "prs">;

type OrbitDef = {
  id: string;
  rx: number;
  ry: number;
  rotateX: number;
  rotateZ: number;
  periodMs: number;
};

/**
 * Stage uses nearly the full score-card content width (w-80 − p-6 ≈ 272px)
 * plus a slight bleed so outer rings reach the card edges.
 */
const STAGE_W = 304;
const STAGE_H = 212;
const HALF_W = STAGE_W / 2;
/**
 * Stage box is 304px, but outer-orbit planets + glow overhang past the box
 * (~322px worst-case). fitScale uses this so avatars never clip the card.
 */
const CONTENT_EXTENT_W = 322;
/** Comfortable gap from card border to planet/glow edge. */
const FIT_MARGIN_PX = 8;

/**
 * Gyroscope / atom: rotateZ −40 / 0 / +40 (≥35° apart) so paths cross;
 * rotateX 50 / 62 / 74 for clearly different openness.
 * Radii ~0.58 / 0.80 / 0.96 of half-width; inner ry clears the avatar ring ≥10px.
 */
const ORBITS: OrbitDef[] = [
  {
    id: "inner",
    // Tall ry so rotateX 50° still reads as an open ellipse that clears the avatar.
    rx: HALF_W * 0.58,
    ry: Math.max(108, HALF_W * 0.72),
    rotateX: 50,
    rotateZ: -40,
    periodMs: 40_000,
  },
  {
    id: "mid",
    rx: HALF_W * 0.8,
    ry: Math.max(88, HALF_W * 0.58),
    rotateX: 62,
    rotateZ: 0,
    periodMs: 60_000,
  },
  {
    id: "outer",
    rx: HALF_W * 0.96,
    ry: Math.max(72, HALF_W * 0.48),
    rotateX: 74,
    rotateZ: 40,
    periodMs: 80_000,
  },
];

const PERSPECTIVE = 800;
const HOVER_SCALE = 1.55;
const AVATAR_RING_R = 52;

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
  frontness: number;
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

/** Higher-star → inner track; phases spread so 3–4 planets sit in front. */
function placePlanets(repos: ImpactOrbitRepo[]): PlacedPlanet[] {
  const ordered = [...repos].toSorted((a, b) => b.stars - a.stars).slice(0, 6);
  const buckets: ImpactOrbitRepo[][] = [[], [], []];
  ordered.forEach((repo, i) => {
    buckets[Math.min(2, Math.floor(i / 2))].push(repo);
  });
  const placed: PlacedPlanet[] = [];
  let globalIndex = 0;
  const total = ordered.length || 1;
  buckets.forEach((bucket, orbitIndex) => {
    const n = bucket.length;
    bucket.forEach((repo, i) => {
      const phase =
        (globalIndex / total + orbitIndex * 0.13 + (n > 1 ? i * 0.04 : 0)) % 1;
      placed.push({
        ...repo,
        owner: repoOwner(repo.repo),
        orbitIndex,
        phase,
        sizePx: planetSizePx(repo.stars),
      });
      globalIndex += 1;
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

  const x = orbit.rx * Math.cos(angle);
  const y = orbit.ry * Math.sin(angle);
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
  let screenX = x1 * scale3d;
  let screenY = y2 * scale3d;

  const zAmp = Math.max(1, orbit.ry * Math.sin(rx));
  const depthNorm = Math.max(-1, Math.min(1, z2 / zAmp));
  const frontness = (depthNorm + 1) / 2;
  const backness = 1 - frontness;

  // Keep front-half planets at/outside the avatar ring so they don't sticker the face.
  if (frontness > 0.5) {
    const dist = Math.hypot(screenX, screenY);
    const minFront = AVATAR_RING_R + 4;
    if (dist > 0.5 && dist < minFront) {
      const s = minFront / dist;
      screenX *= s;
      screenY *= s;
    }
  }

  return {
    x: screenX,
    y: screenY,
    // Back ≥0.75 scale / 0.55 opacity; blur ≤1px; front up to ~1.1
    depthScale: 0.75 + frontness * 0.35,
    opacity: 0.55 + frontness * 0.45,
    blur: backness * 1.0,
    zIndex: Math.round(5 + frontness * 30),
    frontness,
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

export function ImpactOrbit({
  repos,
  tier,
  score,
  locale,
  commitsLabel,
  prsLabel,
  sectionTitle,
  children,
  className = "",
}: {
  repos: ImpactOrbitRepo[];
  tier: Tier;
  score?: number;
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
  const realm = typeof score === "number" ? realmForScore(score) : realmForTier(tier);
  const glow = realm.colors.glow;
  const accent = realm.colors.glow;

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
  const [hoverProj, setHoverProj] = useState<Projected | null>(null);
  const [frostPos, setFrostPos] = useState<{ left: number; top: number } | null>(null);
  /** Fit the fixed-size stage into narrow score cards (e.g. 360–390px phones). */
  const [fitScale, setFitScale] = useState(1);

  const orbitPaths = useMemo(
    () => ORBITS.map((orbit) => ({ id: orbit.id, ...splitOrbitPaths(orbit) })),
    [],
  );

  const activeRepoRef = useRef<string | null>(null);
  const placedRef = useRef(placed);

  const applyPlanetStyle = useCallback(
    (key: string, proj: Projected, hovered: boolean) => {
      const el = planetEls.current.get(key);
      if (!el) return;
      const planet = placedRef.current.find((p) => p.repo === key);
      const sizePx = planet?.sizePx ?? 18;
      const scale = proj.depthScale * (hovered ? HOVER_SCALE : 1);
      const planetR = (sizePx * proj.depthScale) / 2;
      const dist = Math.hypot(proj.x, proj.y);
      // Front planets crossing the inner avatar face → fade so they don't look like stickers.
      // Fade when the planet disc intersects the avatar face/ring (front half only).
      const overlapsFace =
        proj.frontness > 0.4 && dist < AVATAR_RING_R + planetR;
      let opacity = proj.opacity;
      if (overlapsFace && !hovered) opacity = Math.min(opacity, 0.55);
      el.style.transform = `translate(-50%, -50%) translate3d(${proj.x}px, ${proj.y}px, 0) scale(${scale})`;
      el.style.opacity = String(hovered ? 1 : opacity);
      el.style.filter = hovered || proj.blur < 0.05 ? "none" : `blur(${proj.blur}px)`;
      // Keep face-overlapping front planets under the avatar ring.
      const z = overlapsFace && !hovered ? Math.min(proj.zIndex, 18) : proj.zIndex;
      el.style.zIndex = String(hovered ? 60 : z);
      lastProj.current.set(key, proj);
    },
    [],
  );

  const paint = useCallback(
    (elapsedMs: number, frozen: boolean) => {
      const hovered = activeRepoRef.current;
      for (const planet of placedRef.current) {
        const proj = projectPlanet(planet, elapsedMs, frozen);
        applyPlanetStyle(planet.repo, proj, hovered === planet.repo);
      }
    },
    [applyPlanetStyle],
  );

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    if (reducedRef.current) {
      paint(0, true);
      return;
    }
    startRef.current = performance.now() - pauseElapsedRef.current;
    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now;
      const elapsed = now - startRef.current;
      pauseElapsedRef.current = elapsed;
      paint(elapsed, false);
      if (!pausedRef.current && visibleRef.current && !reducedRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [paint]);


  /** Stage-local tip rect, clamped inside the profile card (8px pad), face-clear. */
  function computeFrostPos(
    proj: Projected,
    planet: { sizePx: number },
  ): { left: number; top: number } | null {
    const card = rootRef.current?.closest("[data-profile-score-card]") as HTMLElement | null;
    const stage = stageRef.current;
    if (!card || !stage) return null;

    const cardRect = card.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const scoreEl = card.querySelector("[data-profile-score-value]") as HTMLElement | null;
    const scoreTop = scoreEl ? scoreEl.getBoundingClientRect().top : cardRect.bottom - 48;

    const tipW = 168;
    const tipH = 40;
    const gap = 12;
    const pad = 8;
    const avatarClear = AVATAR_RING_R + 10;
    const planetR = (planet.sizePx * proj.depthScale * HOVER_SCALE) / 2;

    const px = STAGE_W / 2 + proj.x;
    const py = STAGE_H / 2 + proj.y;
    const ax = STAGE_W / 2;
    const ay = STAGE_H / 2;

    // Card bounds → stage-local.
    const minLeft = cardRect.left + pad - stageRect.left;
    const maxLeft = cardRect.right - pad - tipW - stageRect.left;
    const minTop = cardRect.top + pad - stageRect.top;
    const maxTop =
      Math.min(cardRect.bottom - pad, scoreTop - 4) - tipH - stageRect.top;

    const clamp = (left: number, top: number) => ({
      left: Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft)),
      top: Math.min(Math.max(top, minTop), Math.max(minTop, maxTop)),
    });

    const hitsAvatar = (left: number, top: number) => {
      const nearestX = Math.min(Math.max(ax, left), left + tipW);
      const nearestY = Math.min(Math.max(ay, top), top + tipH);
      return Math.hypot(nearestX - ax, nearestY - ay) < avatarClear;
    };

    const outwardH: "left" | "right" = proj.x >= 0 ? "right" : "left";
    const outwardV: "above" | "below" = proj.y >= 0 ? "below" : "above";

    const beside = (side: "left" | "right") => ({
      left: side === "right" ? px + planetR + gap : px - planetR - gap - tipW,
      top: py - tipH / 2,
    });
    const aboveBelow = (where: "above" | "below") => ({
      left: px - tipW / 2,
      top: where === "below" ? py + planetR + gap : py - planetR - gap - tipH,
    });

    const roomFor = (side: "left" | "right") => {
      const raw = beside(side);
      return side === "left" ? raw.left >= minLeft - 0.5 : raw.left <= maxLeft + 0.5;
    };

    // Prefer outward side when it fits; otherwise above/below; then other side.
    const candidates: { left: number; top: number }[] = [];
    if (roomFor(outwardH)) candidates.push(beside(outwardH));
    candidates.push(aboveBelow(outwardV));
    candidates.push(aboveBelow(outwardV === "below" ? "above" : "below"));
    if (!roomFor(outwardH)) candidates.push(beside(outwardH)); // clamped fallback
    const inwardH: "left" | "right" = outwardH === "right" ? "left" : "right";
    if (roomFor(inwardH)) candidates.push(beside(inwardH));
    candidates.push(beside(inwardH));

    let best: { left: number; top: number } | null = null;
    let bestDist = -1;
    for (const raw of candidates) {
      const c = clamp(raw.left, raw.top);
      if (hitsAvatar(c.left, c.top)) continue;
      // Prefer candidates that didn't need a huge clamp nudge.
      const drift = Math.hypot(c.left - raw.left, c.top - raw.top);
      const cx = c.left + tipW / 2;
      const cy = c.top + tipH / 2;
      const dist = Math.hypot(cx - ax, cy - ay) - drift * 0.25;
      if (dist > bestDist) {
        bestDist = dist;
        best = c;
      }
      // First fitting candidate with low drift wins immediately.
      if (drift < 2) return c;
    }
    if (best) return best;

    // Last resort: above/below clamped, then nudge vertically away from face.
    const fallback = clamp(aboveBelow(outwardV).left, aboveBelow(outwardV).top);
    let l = fallback.left;
    let t = fallback.top;
    for (let i = 0; i < 12 && hitsAvatar(l, t); i++) {
      t += outwardV === "below" ? 8 : -8;
      const c = clamp(l, t);
      l = c.left;
      t = c.top;
    }
    return { left: l, top: t };
  }

  function activatePlanet(repoKey: string) {
    const planet = placedRef.current.find((p) => p.repo === repoKey);
    if (!planet) return;
    const proj =
      lastProj.current.get(repoKey) ??
      projectPlanet(planet, pauseElapsedRef.current, reducedRef.current);
    setHoverProj(proj);
    setActiveRepo(repoKey);
    setFrostPos(computeFrostPos(proj, planet));
  }

  function deactivatePlanet() {
    setActiveRepo(null);
    setArmedRepo(null);
    setHoverProj(null);
    setFrostPos(null);
  }

  useEffect(() => {
    activeRepoRef.current = activeRepo;
    placedRef.current = placed;
  }, [activeRepo, placed]);

  useLayoutEffect(() => {
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

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    // Prefer the profile score card's border box — padding is usable bleed on
    // desktop (w-80), but planets+glow still need ≥ FIT_MARGIN_PX from the edge.
    const card = root.closest("[data-profile-score-card]") as HTMLElement | null;
    const target = card ?? root.parentElement ?? root;
    const update = () => {
      const available = target.clientWidth;
      if (available <= 0) return;
      const next = Math.min(1, (available - 2 * FIT_MARGIN_PX) / CONTENT_EXTENT_W);
      setFitScale((prev) => (Math.abs(prev - next) < 0.005 ? prev : next));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(target);
    return () => ro.disconnect();
  }, [placed.length]);

  if (placed.length === 0) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      ref={rootRef}
      className={`impact-orbit-root flex w-full max-w-full flex-col items-center ${className}`}
      data-testid="impact-orbit-root"
    >
      <h2 className="sr-only">{sectionTitle}</h2>

      <div
        ref={stageRef}
        className="impact-orbit-stage relative flex items-center justify-center"
        data-testid="impact-orbit-stage"
        style={
          {
            width: STAGE_W,
            height: STAGE_H,
            perspective: `${PERSPECTIVE}px`,
            transformStyle: "preserve-3d",
            overflow: "visible",
            "--impact-orbit-size": `${STAGE_W}px`,
            transform: fitScale < 1 ? `scale(${fitScale})` : undefined,
            transformOrigin: "top center",
            marginBottom: fitScale < 1 ? -(STAGE_H * (1 - fitScale)) : undefined,
          } as CSSProperties
        }
      >
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={STAGE_W}
          height={STAGE_H}
          viewBox={`${-STAGE_W / 2} ${-STAGE_H / 2} ${STAGE_W} ${STAGE_H}`}
          aria-hidden
          data-testid="impact-orbit-rings"
        >
          {orbitPaths.map((path) => (
            <g key={path.id}>
              {path.back ? (
                <path
                  d={path.back}
                  fill="none"
                  stroke={withAlpha(accent, 0.34)}
                  strokeWidth={1}
                  strokeDasharray="3 4"
                />
              ) : null}
              {path.front ? (
                <path
                  d={path.front}
                  fill="none"
                  stroke={withAlpha(accent, 0.42)}
                  strokeWidth={1.15}
                />
              ) : null}
            </g>
          ))}
        </svg>

        <div className="relative z-[20] flex items-center justify-center">{children}</div>

        {placed.map((planet) => {
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
                onMouseEnter={() => activatePlanet(planet.repo)}
                onMouseLeave={() => deactivatePlanet()}
                onFocus={() => activatePlanet(planet.repo)}
                onBlur={() => deactivatePlanet()}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (typeof window === "undefined") return;
                  if (!window.matchMedia("(pointer: coarse)").matches) return;
                  if (armedRepo !== planet.repo) {
                    event.preventDefault();
                    setArmedRepo(planet.repo);
                    activatePlanet(planet.repo);
                  }
                }}
                onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) => {
                  if (event.key === "Escape") deactivatePlanet();
                }}
              >
                <PlanetAvatar
                  owner={planet.owner}
                  size={planet.sizePx}
                  accent={accent}
                  glow={glow}
                />
              </a>
            </div>
          );
        })}

        {activeRepo && hoverProj && frostPos
          ? (() => {
              const planet = placed.find((p) => p.repo === activeRepo);
              if (!planet) return null;
              const activity = activityParts(planet, commitsLabel, prsLabel, formatStars);
              return (
                <div
                  className="pointer-events-none absolute z-[70] whitespace-nowrap rounded-md px-2 py-1 text-left shadow-lg"
                  data-testid="impact-orbit-frost"
                  style={{
                    left: frostPos.left,
                    top: frostPos.top,
background: "rgba(24, 24, 27, 0.72)",
                    backdropFilter: "blur(10px)",
                    WebkitBackdropFilter: "blur(10px)",
                    border: `1px solid ${withAlpha(accent, 0.5)}`,
                    minWidth: "max-content",
                  }}
                  role="tooltip"
                >
                  <div className="text-[11px] font-semibold leading-tight text-zinc-100">
                    {planet.repo}
                  </div>
                  <div className="mt-0.5 whitespace-nowrap text-[10px] tabular-nums leading-tight text-zinc-300">
                    ⭐ {formatStars(planet.stars)}
                    {activity ? (
                      <span className="ms-1.5 text-zinc-400">{activity}</span>
                    ) : null}
                  </div>
                </div>
              );
            })()
          : null}
      </div>
    </div>
  );
}
