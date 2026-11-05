"use client";

import { useEffect } from "react";
import { MAX_SLOT_EVENTS, parseSlotRef, SLOT_ATTR, SLOT_ENDPOINT, type SlotEvent } from "@/lib/slot-metrics";

/** An impression is ≥50% of the slot on screen for a continuous second. */
const VISIBLE_RATIO = 0.5;
const VISIBLE_MS = 1000;
const FLUSH_MS = 5000;

/**
 * Counts impressions and clicks on every `[data-track-slot]` element (see
 * slotAttrs in src/lib/slot-metrics.ts) and beacons them to
 * POST /api/sponsors/pulse. Mounted once per page shell, so server-rendered
 * cards (hiring, jobs) need only the attribute and ship no JS of their own.
 * Each slot counts one impression per page path; every click counts.
 * Renders nothing.
 */
export function SlotMetrics() {
  useEffect(() => {
    // Same rule as the GA snippet: headless automation sends nothing.
    if (typeof IntersectionObserver === "undefined" || navigator.webdriver) return;

    let queue: [SlotEvent, string][] = [];
    const seen = new Set<string>();
    const timers = new Map<Element, number>();

    const flush = () => {
      if (queue.length === 0) return;
      const batch = queue.slice(0, MAX_SLOT_EVENTS);
      queue = queue.slice(MAX_SLOT_EVENTS);
      // text/plain keeps the beacon a CORS-safelisted request.
      const body = new Blob([JSON.stringify({ e: batch })], { type: "text/plain" });
      if (!navigator.sendBeacon?.(SLOT_ENDPOINT, body)) {
        void fetch(SLOT_ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {});
      }
      if (queue.length) flush();
    };

    const push = (event: SlotEvent, key: string) => {
      queue.push([event, key]);
      if (event === "click" || queue.length >= MAX_SLOT_EVENTS) flush();
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = entry.target.getAttribute(SLOT_ATTR);
          if (!key) continue;
          const pending = timers.get(entry.target);
          if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO) {
            if (pending !== undefined) continue;
            timers.set(
              entry.target,
              window.setTimeout(() => {
                timers.delete(entry.target);
                const seenKey = `${location.pathname}#${key}`;
                if (seen.has(seenKey)) return;
                seen.add(seenKey);
                push("impression", key);
              }, VISIBLE_MS),
            );
          } else if (pending !== undefined) {
            window.clearTimeout(pending);
            timers.delete(entry.target);
          }
        }
      },
      { threshold: [0, VISIBLE_RATIO] },
    );

    const observed = new WeakSet<Element>();
    const watch = (el: Element) => {
      if (observed.has(el) || !parseSlotRef(el.getAttribute(SLOT_ATTR))) return;
      observed.add(el);
      observer.observe(el);
    };
    const scan = (root: Element | Document) => {
      if (root instanceof Element && root.hasAttribute(SLOT_ATTR)) watch(root);
      root.querySelectorAll(`[${SLOT_ATTR}]`).forEach(watch);
    };
    scan(document);
    // Sponsor cells render after their client fetch, and client navigation
    // swaps whole pages, so watch for slots arriving later.
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) scan(node);
        });
      }
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    const onClick = (event: MouseEvent) => {
      if (event.type === "auxclick" && event.button !== 1) return;
      const el = (event.target as Element | null)?.closest?.(`[${SLOT_ATTR}]`);
      const key = el?.getAttribute(SLOT_ATTR);
      if (key && parseSlotRef(key)) push("click", key);
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const interval = window.setInterval(flush, FLUSH_MS);

    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      observer.disconnect();
      mutations.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
      window.clearInterval(interval);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
    };
  }, []);
  return null;
}
