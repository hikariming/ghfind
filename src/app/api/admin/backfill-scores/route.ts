import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import * as db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;

interface BackfillCanonicalScoresPageInput {
  apply: boolean;
  limit: number;
  cursor: string | null;
}

interface BackfillCanonicalScoresPageResult {
  dryRun: boolean;
  processed: number;
  eligible: number;
  materialized: number;
  skipped: number;
  rejected: number;
  failed: number;
  nextCursor: string | null;
}

type BackfillDb = {
  backfillCanonicalScoresPage: (
    input: BackfillCanonicalScoresPageInput,
  ) => Promise<BackfillCanonicalScoresPageResult | null>;
};

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  const supplied = req.headers.get("x-admin-secret");
  return Boolean(secret && supplied && secureEqual(supplied, secret));
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function publicResult(
  result: BackfillCanonicalScoresPageResult,
  dryRun: boolean,
): BackfillCanonicalScoresPageResult | null {
  const processed = nonNegativeInteger(result.processed);
  const eligible = nonNegativeInteger(result.eligible);
  const materialized = nonNegativeInteger(result.materialized);
  const skipped = nonNegativeInteger(result.skipped);
  const rejected = nonNegativeInteger(result.rejected);
  const failed = nonNegativeInteger(result.failed);
  const nextCursor = result.nextCursor;

  if (
    processed === null ||
    eligible === null ||
    materialized === null ||
    skipped === null ||
    rejected === null ||
    failed === null ||
    (nextCursor !== null &&
      (typeof nextCursor !== "string" ||
        nextCursor.length === 0 ||
        nextCursor.length > MAX_CURSOR_LENGTH))
  ) {
    return null;
  }

  return {
    dryRun,
    processed,
    eligible,
    materialized,
    skipped,
    rejected,
    failed,
    nextCursor,
  };
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_BATCH_LIMIT;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_BATCH_LIMIT
    ? value
    : null;
}

function parseCursor(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH ||
    value.trim() !== value
  ) {
    return undefined;
  }
  return value;
}

/**
 * Process one bounded keyset page. Mutation is disabled by default and can be
 * stopped independently from the deployment by the pause switch.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  if (process.env.BACKFILL_SCORES_PAUSED === "1") {
    return json({ error: "backfill_paused", paused: true }, 409);
  }

  const rawBody = await req.text();
  let body: Record<string, unknown> = {};
  if (rawBody.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return json({ error: "invalid_request" }, 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
  }

  if (Object.hasOwn(body, "offset")) {
    return json({ error: "offset_not_supported" }, 400);
  }

  const limit = parseLimit(body.limit);
  if (limit === null) return json({ error: "invalid_limit" }, 400);
  const cursor = parseCursor(body.cursor);
  if (cursor === undefined) return json({ error: "invalid_cursor" }, 400);

  const apply = body.apply === true;
  if (apply && process.env.BACKFILL_SCORES_APPLY_ENABLED !== "1") {
    return json({ error: "apply_disabled" }, 409);
  }

  const backfillCanonicalScoresPage = (db as unknown as BackfillDb)
    .backfillCanonicalScoresPage;
  if (typeof backfillCanonicalScoresPage !== "function") {
    return json({ error: "storage_unavailable" }, 503);
  }

  try {
    const result = await backfillCanonicalScoresPage({ apply, limit, cursor });
    if (!result) return json({ error: "storage_unavailable" }, 503);
    const response = publicResult(result, !apply);
    if (!response) return json({ error: "invalid_storage_response" }, 503);
    return json(response);
  } catch {
    return json({ error: "storage_unavailable" }, 503);
  }
}
