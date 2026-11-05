/**
 * Impression/click metrics for sponsored placements, rolled up per Beijing day
 * into D1 `ad_daily_stats` (migrations/0034). Shared by the client tracker
 * (src/components/SlotMetrics.tsx) and POST /api/sponsors/pulse.
 *
 * Deliberately avoids "ad" in DOM attributes and URLs: generic ad-block
 * filters hide `[data-ad…]` elements and block `/ads/` paths, which would drop
 * the very cells being measured (see src/app/api/sponsors/[id]/visit).
 */

/**
 * What the slot points at, and so which table resolves its advertiser:
 * sponsor → sponsorships, job → jobs, company → job_companies,
 * static → STATIC_SLOTS (hard-coded credits with no D1 row).
 */
export const SLOT_KINDS = ["sponsor", "job", "company", "static"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** Where on the site the slot was shown. Closed so reports group cleanly. */
export const SLOT_PLACEMENTS = [
  "top_strip", // 夯 strip above every page's content (头部)
  "home_row", // 人上人 row under the homepage scan box (中间)
  "model_credit", // model sponsor credit under the homepage scan box
  "footer", // "Powered by" credit in the site footer
  "pill", // standalone "Powered by" pill
  "sponsor_page", // current-holder lists on /sponsor
  "home_hiring", // hiring cards on the homepage
  "jobs_board", // hiring cards and careers links on /jobs
  "job_detail", // apply button and company link on /jobs/<id>
] as const;
export type SlotPlacement = (typeof SLOT_PLACEMENTS)[number];

export const SLOT_EVENTS = ["impression", "click"] as const;
export type SlotEvent = (typeof SLOT_EVENTS)[number];

/** Hard-coded credits: slot id → advertiser key. */
export const STATIC_SLOTS: Readonly<Record<string, string>> = {
  minicpm: "minicpm",
};

export const SLOT_ATTR = "data-track-slot";
export const SLOT_ENDPOINT = "/api/sponsors/pulse";
/** Per request; the client flushes well below this. */
export const MAX_SLOT_EVENTS = 40;

export interface SlotRef {
  kind: SlotKind;
  id: string;
  placement: SlotPlacement;
}

export interface SlotHit extends SlotRef {
  event: SlotEvent;
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** Spread onto a link: `<a {...slotAttrs("sponsor", id, "home_row")}>`. */
export function slotAttrs(kind: SlotKind, id: string, placement: SlotPlacement): Record<typeof SLOT_ATTR, string> {
  return { [SLOT_ATTR]: `${kind}|${id}|${placement}` } as Record<typeof SLOT_ATTR, string>;
}

export function parseSlotRef(value: string | null | undefined): SlotRef | null {
  if (!value) return null;
  const [kind, id, placement, extra] = value.split("|");
  if (extra !== undefined) return null;
  if (!(SLOT_KINDS as readonly string[]).includes(kind)) return null;
  if (!(SLOT_PLACEMENTS as readonly string[]).includes(placement)) return null;
  if (!id || !ID_RE.test(id)) return null;
  if (kind === "static" && !Object.hasOwn(STATIC_SLOTS, id)) return null;
  return { kind: kind as SlotKind, id, placement: placement as SlotPlacement };
}

/** Wire format: `{ "e": [["click", "sponsor|id|home_row"], …] }`. */
export function parseSlotHits(body: unknown): SlotHit[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { e?: unknown }).e;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SLOT_EVENTS) return null;
  const hits: SlotHit[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [event, key] = entry;
    if (!(SLOT_EVENTS as readonly string[]).includes(event)) return null;
    const ref = parseSlotRef(typeof key === "string" ? key : null);
    if (!ref) return null;
    hits.push({ ...ref, event: event as SlotEvent });
  }
  return hits;
}

export interface SlotCount extends SlotRef {
  impressions: number;
  clicks: number;
}

/** Collapse hits to one counter row per slot. */
export function countSlotHits(hits: SlotHit[]): SlotCount[] {
  const rows = new Map<string, SlotCount>();
  for (const hit of hits) {
    const key = `${hit.kind}|${hit.id}|${hit.placement}`;
    const row = rows.get(key) ?? { kind: hit.kind, id: hit.id, placement: hit.placement, impressions: 0, clicks: 0 };
    if (hit.event === "click") row.clicks += 1;
    else row.impressions += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Beijing calendar date (UTC+8, no DST) as YYYY-MM-DD. */
export function beijingDay(nowMs: number): string {
  return new Date(nowMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}
