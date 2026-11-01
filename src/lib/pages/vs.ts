import { getGoVsPresentation } from "@/lib/go-profile.server";
import { normLang } from "@/lib/lang";
import { decodeRouteParam } from "@/lib/route-params";
import { VS_MIN_SCORE } from "@/lib/site";
import type { RoastLine } from "@/lib/types";
import { normalizeUsername } from "@/lib/username";

/** /vs/[a]/[b] logic shared by the Next page and apps/web. */

/** Pick the content-language side of a bilingual line, falling back to the other. */
export function localeSide(line: RoastLine | null | undefined, locale: string): string {
  if (!line) return "";
  return normLang(locale) === "en" ? line.en || line.zh : line.zh || line.en;
}

/** Normalize + canonicalize (lowercased, dictionary order) a /vs pair, or null
 *  if either handle is invalid. */
export function canonicalize(a: string, b: string): { a: string; b: string } | null {
  const na = normalizeUsername(decodeRouteParam(a));
  const nb = normalizeUsername(decodeRouteParam(b));
  if (!na || !nb) return null;
  const [x, y] = [na.toLowerCase(), nb.toLowerCase()].sort();
  return { a: x, b: y };
}

export type VsPresentation = Awaited<ReturnType<typeof getGoVsPresentation>>;

/** Whether the requested spelling isn't the canonical slug (case/order) → redirect. */
export function isCanonicalVsPath(a: string, b: string, pair: { a: string; b: string }): boolean {
  return decodeRouteParam(a) === pair.a && decodeRouteParam(b) === pair.b;
}

/**
 * Metadata inputs: index only a matchup that earned an LLM verdict AND clears
 * the floor on both sides — keeps N² UGC pairs out of the index but lets real,
 * judged duels rank.
 */
export function vsMeta(locale: string, pair: { a: string; b: string }, presentation: VsPresentation) {
  const image =
    normLang(locale) === "en"
      ? `/api/card/vs/${pair.a}/${pair.b}`
      : `/api/card/vs/${pair.a}/${pair.b}?lang=zh`;
  const matchup = presentation?.matchup;
  const indexable =
    !!matchup?.verdict &&
    matchup.scoreA >= VS_MIN_SCORE &&
    matchup.scoreB >= VS_MIN_SCORE;
  return { image, indexable, path: `/vs/${pair.a}/${pair.b}` };
}
