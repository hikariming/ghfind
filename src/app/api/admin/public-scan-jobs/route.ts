import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getPublicScanJobVersionSummary,
  quarantineObsoletePublicScanJobs,
} from "@/lib/db";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 100;

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

function boundedLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BATCH_LIMIT;
  return Math.max(1, Math.min(MAX_BATCH_LIMIT, Math.floor(parsed)));
}

/** Aggregate inventory only; no account or job identifiers leave this endpoint. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  const versions = await getPublicScanJobVersionSummary();
  if (!versions) return json({ error: "storage_unavailable" }, 503);
  return json({
    canonicalCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    versions,
  });
}

/**
 * Dry-run by default. Applying a bounded batch additionally requires the
 * deployment-level switch, preventing an accidental request from mutating jobs.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "forbidden" }, 403);
  const parsed = await req.json().catch(() => null);
  const body: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const apply = body.apply === true;
  if (apply && process.env.PUBLIC_SCAN_QUARANTINE_ENABLED !== "1") {
    return json({ error: "quarantine_disabled" }, 409);
  }

  const result = await quarantineObsoletePublicScanJobs({
    canonicalCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    apply,
    limit: boundedLimit(body.limit),
  });
  if (!result) return json({ error: "storage_unavailable" }, 503);
  return json({
    canonicalCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    ...result,
  });
}
