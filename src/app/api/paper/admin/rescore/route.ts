import { NextRequest, NextResponse } from "next/server";
import { fetchPaperCitations } from "@/lib/arxiv";
import { getAllPapers, rescorePaperScore } from "@/lib/db";
import { citationBonus, finalScore, paperTierFor } from "@/lib/paper-score";
import type { PaperData } from "@/lib/paper-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * One-off backfill: refresh Semantic Scholar citation signals for already-stored
 * papers and recompute their score. Existing rows were scored when the keyless
 * S2 pool was 429-ing, so their citation_bonus is 0 and everything caps at the
 * 80-pt content ceiling — this re-lifts the genuinely-cited ones (神作榜).
 *
 * LLM-free: the content dims are already stored; only the deterministic citation
 * bonus is recomputed. Guarded by ADMIN_SECRET (no default → endpoint is inert
 * until you set one). Runs sequentially to respect the S2 rate limit; use
 * ?limit=&offset= to process in batches if it nears the function timeout.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers.get("x-admin-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const limit = Math.max(0, Number(url.searchParams.get("limit")) || 0);
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const dryRun = url.searchParams.get("dry") === "1";
  // Pace requests to ~1/s — the keyless S2 pool 429s on bursts, so spacing them
  // out lifts the hit-rate while you wait on an API key. With a key you can drop
  // this to 0 (?delayMs=0). Capped so a typo can't stall the function.
  const rawDelay = Number(url.searchParams.get("delayMs"));
  const delayMs = Math.min(5000, Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 1100);

  const all = await getAllPapers();
  const batch = limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset);

  let updated = 0;
  let missed = 0;
  let unchanged = 0;
  const changes: { id: string; from: number; to: number }[] = [];

  for (let i = 0; i < batch.length; i++) {
    const p = batch[i];
    if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const c = await fetchPaperCitations(p.arxiv_id);
    // A live miss returns null citation_count — don't clobber existing data,
    // just skip (the score stays as-is). Only re-score on a real fetch.
    if (c.citation_count == null) {
      missed++;
      continue;
    }
    // citationBonus only reads the three citation fields off PaperData.
    const signals = {
      citation_count: c.citation_count,
      influential_citation_count: c.influential_citation_count,
      venue: c.venue ?? p.venue,
    } as PaperData;
    const bonus = citationBonus(signals);
    const final = finalScore(p.dims, signals);
    const tier = paperTierFor(final);

    if (final === p.final_score && bonus === p.citation_bonus) {
      unchanged++;
      continue;
    }
    if (!dryRun) {
      await rescorePaperScore(p.arxiv_id, {
        citation_count: c.citation_count,
        influential_citation_count: c.influential_citation_count,
        venue: c.venue ?? p.venue,
        citation_bonus: bonus,
        final_score: final,
        tier,
      });
    }
    updated++;
    changes.push({ id: p.arxiv_id, from: p.final_score, to: final });
  }

  return NextResponse.json({
    dryRun,
    total: all.length,
    processed: batch.length,
    offset,
    updated,
    missed,
    unchanged,
    // biggest lifts first — these are the 神作榜 candidates
    topChanges: changes.sort((a, b) => b.to - a.to).slice(0, 20),
  });
}
