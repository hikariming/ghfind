"use client";

import { useEffect, useRef, useState } from "react";
import {
  ROAST_PROGRESS_COMPLETE_MS,
  ROAST_PROGRESS_FADE_MS,
  clearRoastStart,
  holdProgress,
  nextStageFloor,
  readRoastStart,
  rememberRoastStart,
  resolveStartedAtMs,
  roastProgress,
  stageFloorForLabel,
  type RoastGenerator,
} from "@/lib/roast-progress";

export interface RoastProgressDriver {
  percent: number;
  stageIndex: number;
  /** Cross-fade the card out after the ring reaches 100%. */
  fading: boolean;
  /** Drop the card once the fade finishes. */
  hidden: boolean;
  noteThinking: (label: string) => void;
  /** Switch τ once /api/roast names v12 or v13. Unknown stays on the longer v13 curve. */
  setGenerator: (generator: RoastGenerator) => void;
  /**
   * Re-anchor the curve at a durable job's start. A later or equal start is
   * ignored, so the ring never jumps backward when a frame repeats.
   */
  noteStarted: (startedAtMs: number) => void;
  markComplete: () => void;
  reset: () => void;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Drive the pseudo-progress ring. `active` means a roast request is in flight
 * (or already known to be running). A stored start time resumes the curve;
 * otherwise an in-flight job is seeded above 0%.
 */
export function useRoastProgress(
  active: boolean,
  username: string,
  lang: string,
  options?: { resume?: boolean },
): RoastProgressDriver {
  const startedAtRef = useRef<number | null>(null);
  const floorRef = useRef(0);
  const generatorRef = useRef<RoastGenerator | null>(null);
  const highPercentRef = useRef(0);
  const highStageRef = useRef(0);
  const completeAtRef = useRef<number | null>(null);
  const publishRef = useRef<(now: number) => void>(() => {});
  const reducedRef = useRef(false);
  const resume = options?.resume === true;
  const [percent, setPercent] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [settled, setSettled] = useState(false);
  const [fading, setFading] = useState(false);
  const [hidden, setHidden] = useState(false);

  const publish = (nowMs: number) => {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    // Clock skew / future start would clamp elapsed to 0 forever — re-anchor.
    if (startedAtRef.current != null && now < startedAtRef.current) {
      startedAtRef.current = now;
      rememberRoastStart(username, lang, now);
    }
    const started = startedAtRef.current ?? now;
    const completeAt = completeAtRef.current;
    const next = roastProgress({
      elapsedMs: Math.max(0, now - started),
      complete: completeAt != null,
      completeElapsedMs: completeAt == null ? 0 : Math.max(0, now - completeAt),
      stageFloor: floorRef.current,
      reducedMotion: reducedRef.current,
      generator: generatorRef.current,
    });
    const held = holdProgress(
      { percent: highPercentRef.current, stageIndex: highStageRef.current },
      next,
    );
    highPercentRef.current = held.percent;
    highStageRef.current = held.stageIndex;
    setPercent(held.percent);
    setStageIndex(held.stageIndex);
    setSettled(held.settled || held.percent >= 100);
  };

  useEffect(() => {
    publishRef.current = publish;
  });

  const markComplete = () => {
    if (completeAtRef.current != null) return;
    completeAtRef.current = Date.now();
    publishRef.current(Date.now());
    window.setTimeout(() => publishRef.current(Date.now()), ROAST_PROGRESS_COMPLETE_MS);
  };

  useEffect(() => {
    reducedRef.current = prefersReducedMotion();
    if (!active) return;
    const now = Date.now();
    if (startedAtRef.current == null) {
      // Future/stale sessionStorage values are ignored so skew cannot pin at 0%.
      startedAtRef.current = resolveStartedAtMs(readRoastStart(username, lang), now, {
        resume,
      });
      rememberRoastStart(username, lang, startedAtRef.current);
    }
    publishRef.current(now);
    // Always tick through the ref so a mid-stream setGenerator / noteThinking
    // republish sees the latest closure without resetting the interval.
    const timer = window.setInterval(
      () => publishRef.current(Date.now()),
      reducedRef.current ? 800 : 200,
    );
    return () => window.clearInterval(timer);
  }, [active, username, lang, resume]);

  useEffect(() => {
    if (!settled) return;
    const fade = window.setTimeout(() => setFading(true), 0);
    const hide = window.setTimeout(() => {
      setHidden(true);
      clearRoastStart(username, lang);
    }, ROAST_PROGRESS_FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(hide);
    };
  }, [settled, username, lang]);

  return {
    percent,
    stageIndex,
    fading,
    hidden,
    noteThinking(label: string) {
      floorRef.current = nextStageFloor(floorRef.current, stageFloorForLabel(label));
      publishRef.current(Date.now());
    },
    setGenerator(generator: RoastGenerator) {
      if (generatorRef.current === generator) return;
      generatorRef.current = generator;
      publishRef.current(Date.now());
    },
    noteStarted(startedAtMs: number) {
      if (!Number.isFinite(startedAtMs)) return;
      const now = Date.now();
      if (now < startedAtMs || now - startedAtMs > 15 * 60_000) return;
      const current = startedAtRef.current;
      // Only an earlier start moves the ring forward. A later one would rewind it.
      if (current != null && startedAtMs >= current) return;
      startedAtRef.current = startedAtMs;
      rememberRoastStart(username, lang, startedAtMs);
      publishRef.current(now);
    },
    markComplete,
    reset() {
      const now = Date.now();
      // Re-anchor even when the ring is already active, so a retry starts over.
      startedAtRef.current = now;
      floorRef.current = 0;
      generatorRef.current = null;
      highPercentRef.current = 0;
      highStageRef.current = 0;
      completeAtRef.current = null;
      setFading(false);
      setHidden(false);
      setSettled(false);
      setPercent(0);
      setStageIndex(0);
      clearRoastStart(username, lang);
    },
  };
}
