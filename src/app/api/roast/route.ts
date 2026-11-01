import type { NextRequest } from "next/server";
import { handleRoastPost } from "@/lib/roast-handler";

export { ROAST_META_HEADER } from "@/lib/roast-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One LLM call writes the streamed report. Scores are deterministic API data, so
// the model never gets to adjust them. The ceiling remains generous for provider
// failover, while the inner deadline keeps failures inside the in-band protocol
// instead of letting the platform 504.
// The ceiling is 240s (well under Vercel's 300s max) so a stalled primary can
// fail over to DeepSeek and STILL have a fresh budget to finish — the old 120s
// cap physically couldn't fit primary + fallback, so the fallback got ~0s and
// timed out. Fluid Compute bills active CPU,
// not the idle wait on the model, so the higher ceiling costs ~nothing. The LLM
// work is bounded a touch under this (`llmDeadlineMs`) so we fail gracefully here
// (roast_failed) instead of the platform 504'ing. Keep the inner budget below it.
export const maxDuration = 240;

export function POST(req: NextRequest) {
  return handleRoastPost(req);
}
