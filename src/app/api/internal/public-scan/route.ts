import { Receiver } from "@upstash/qstash";
import { NextRequest, NextResponse } from "next/server";
import { processPublicScanJob } from "@/lib/public-scan-worker";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface WorkerBody {
  jobId?: unknown;
}

function localWorkerAuthorized(req: NextRequest): boolean {
  // Local integration tests and self-hosted operators can invoke the worker
  // without exposing it publicly. Production must use QStash signatures.
  if (process.env.NODE_ENV === "production") return false;
  const secret = process.env.PUBLIC_SCAN_WORKER_SECRET;
  return Boolean(secret && req.headers.get("x-public-scan-worker-secret") === secret);
}

async function qstashAuthorized(req: NextRequest, rawBody: string): Promise<boolean> {
  const signature = req.headers.get("upstash-signature");
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!signature || !currentSigningKey || !nextSigningKey) return false;
  try {
    const receiver = new Receiver({ currentSigningKey, nextSigningKey });
    return await receiver.verify({
      signature,
      body: rawBody,
      url: `${SITE_URL}/api/internal/public-scan`,
    });
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!(await qstashAuthorized(req, rawBody)) && !localWorkerAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: WorkerBody;
  try {
    body = JSON.parse(rawBody) as WorkerBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof body.jobId !== "string" || !body.jobId) {
    return NextResponse.json({ error: "invalid_job" }, { status: 400 });
  }

  // The durable row owns retry state. A successful HTTP acknowledgement avoids
  // QStash multiplying a job delivery after the worker already persisted its
  // own next cursor or backoff.
  const result = await processPublicScanJob(body.jobId);
  return NextResponse.json(result);
}
