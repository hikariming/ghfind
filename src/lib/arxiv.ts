/**
 * arXiv + Semantic Scholar fetch layer — the paper equivalent of GitHub's
 * `collect()`. Pulls objective paper data ("scan") that the LLM rubric and the
 * citation-bonus score build on. No external SDK: arXiv returns Atom XML (parsed
 * with light regex over the single-entry feed) and Semantic Scholar returns JSON.
 */

import type { PaperData } from "./paper-types";

const ARXIV_API = "https://export.arxiv.org/api/query";
const S2_API = "https://api.semanticscholar.org/graph/v1/paper";
const USER_AGENT = `${process.env.PUBLIC_SITE_URL || "githubroast.dev"} paper-review`;

export class PaperNotFoundError extends Error {}

/** fetch with an abort timeout — arXiv/S2 can be slow/unreachable (e.g. from CN),
 *  and without this the request hangs forever and freezes the scan button. */
async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a canonical arXiv id (no version) from a raw id or any arXiv URL.
 * Handles new-style `1706.03762`, old-style `cs/0309136`, `arXiv:` prefixes,
 * `/abs/`, `/pdf/`, and trailing `vN`. Returns null if nothing looks like an id.
 */
export function normalizeArxivId(input: string): string | null {
  const s = input.trim();
  const newStyle = s.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (newStyle) return newStyle[1];
  const oldStyle = s.match(/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  if (oldStyle) return oldStyle[1];
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : null;
}

/** Fetch + parse the arXiv Atom entry. Throws PaperNotFoundError if absent. */
async function fetchArxivMeta(id: string): Promise<Omit<PaperData, "citation_count" | "influential_citation_count" | "venue" | "tldr">> {
  const res = await fetchTimeout(
    `${ARXIV_API}?id_list=${encodeURIComponent(id)}&max_results=1`,
    { headers: { "User-Agent": USER_AGENT } },
    12000,
  );
  if (!res.ok) throw new Error(`arXiv API ${res.status}`);
  const xml = await res.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
  // arXiv returns a stub entry with no <id> for unknown ids.
  if (!entry || /arxiv.org\/api\/errors/.test(entry) || !tag(entry, "title")) {
    throw new PaperNotFoundError(id);
  }
  const authors = Array.from(entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)).map((m) =>
    decodeEntities(m[1].trim()),
  );
  const categories = Array.from(entry.matchAll(/<category[^>]*term="([^"]+)"/gi)).map((m) => m[1]);
  return {
    arxiv_id: id,
    title: tag(entry, "title") ?? id,
    authors,
    abstract: tag(entry, "summary") ?? "",
    categories: Array.from(new Set(categories)),
    published: tag(entry, "published"),
  };
}

interface S2Response {
  citationCount?: number;
  influentialCitationCount?: number;
  venue?: string;
  tldr?: { text?: string } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Best-effort citation signals from Semantic Scholar; all null on miss/error.
 *
 * The keyless S2 pool is shared and rate-limits hard (HTTP 429) under any load,
 * which used to silently zero out every paper's citation bonus (capping scores
 * at the 80-pt content ceiling). We now retry the 429s and log misses so the
 * failure is visible. The real fix for production is SEMANTIC_SCHOLAR_API_KEY.
 */
async function fetchCitations(id: string): Promise<Pick<PaperData, "citation_count" | "influential_citation_count" | "venue" | "tldr">> {
  const empty = { citation_count: null, influential_citation_count: null, venue: null, tldr: null };
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const url = `${S2_API}/arXiv:${encodeURIComponent(id)}?fields=citationCount,influentialCitationCount,venue,tldr`;
  // One initial try + 2 retries: a keyless 429 usually clears within ~1–2s once
  // the shared pool frees up. With a key the first try almost always succeeds.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchTimeout(url, { headers }, 8000);
      if (res.status === 429 && attempt < 2) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        console.warn(`S2 citations ${id}: HTTP ${res.status}`);
        return empty;
      }
      const j = (await res.json()) as S2Response;
      return {
        citation_count: typeof j.citationCount === "number" ? j.citationCount : null,
        influential_citation_count:
          typeof j.influentialCitationCount === "number" ? j.influentialCitationCount : null,
        venue: j.venue || null,
        tldr: j.tldr?.text || null,
      };
    } catch (e) {
      if (attempt < 2) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      console.warn(`S2 citations ${id} failed:`, e);
    }
  }
  return empty;
}

/** Public re-fetch of just the citation signals — used by the rescore backfill
 *  to refresh stored papers without re-hitting the arXiv metadata endpoint. */
export async function fetchPaperCitations(
  id: string,
): Promise<Pick<PaperData, "citation_count" | "influential_citation_count" | "venue" | "tldr">> {
  return fetchCitations(id);
}

/** Full paper "scan": arXiv metadata + (best-effort) citation signals. */
export async function fetchPaper(id: string): Promise<PaperData> {
  const [meta, cites] = await Promise.all([fetchArxivMeta(id), fetchCitations(id)]);
  return { ...meta, ...cites };
}
