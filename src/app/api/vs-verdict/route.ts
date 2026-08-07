import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkBotId } from "botid/server";
import { goBackendOrigin } from "@/lib/go-backend.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function clientIp(request: NextRequest): string {
  const vercelForwarded = request.headers.get("x-vercel-forwarded-for")?.trim();
  if (vercelForwarded) return vercelForwarded.split(",")[0]?.trim() || "0.0.0.0";
  return "unknown";
}

/**
 * Vercel BotID needs the platform request context, so this is intentionally
 * the one verification gateway that cannot be a transparent rewrite. It owns
 * no validation, rate limiting, data access, cache/lock, prompt, or LLM work:
 * after BotID it forwards the exact request body to Go with an HMAC-bound
 * client identity. The Go API rejects direct Railway calls without it.
 */
export async function POST(request: NextRequest) {
  const origin = goBackendOrigin();
  const gatewaySecret = process.env.GHFIND_VERDICT_GATEWAY_SECRET?.trim();
  if (!origin || !gatewaySecret) {
    return NextResponse.json(
      {
        error: "backend_not_configured",
        message: "The Go verdict gateway is not configured for this deployment.",
      },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" } },
    );
  }

  const verification = await checkBotId();
  if (verification.isBot && !verification.isVerifiedBot) {
    return NextResponse.json(
      {
        error: "bot_detected",
        hint: "Automated clients are welcome: use the documented API and MCP server at https://ghfind.com/docs (free, no headless browser required).",
      },
      { status: 403 },
    );
  }

  const body = await request.text();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const principal = clientIp(request);
  const signature = createHmac("sha256", gatewaySecret)
    .update(`${timestamp}\n${principal}\n${body}`, "utf8")
    .digest("hex");

  try {
    const response = await fetch(`${origin}/api/internal/vs-verdict`, {
      method: "POST",
      body,
      headers: {
        Accept: "application/json",
        "Content-Type": request.headers.get("content-type") || "application/json",
        "X-Ghfind-Gateway-Timestamp": timestamp,
        "X-Ghfind-Client-IP": principal,
        "X-Ghfind-Gateway-Signature": signature,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(110_000),
    });
    const headers = new Headers();
    for (const name of ["cache-control", "retry-after", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("Content-Type", response.headers.get("content-type") || "application/json; charset=utf-8");
    return new NextResponse(response.body, { status: response.status, headers });
  } catch {
    return NextResponse.json(
      { verdict: null, reason: "failed" },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" } },
    );
  }
}
