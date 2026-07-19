import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

/**
 * Structured JSON errors for the public API. Compatibility-first: the top-level
 * `error` stays a plain string code (the published npm/PyPI SDKs and Go CLI parse
 * it), and we ADD sibling `message` + `hint` fields that agents can read. No
 * breaking change to existing clients.
 */
export type ApiErrorCode =
  | "invalid_body"
  | "invalid_username"
  | "turnstile_failed"
  | "rate_limited"
  | "rate_limit_unavailable"
  | "account_not_found"
  | "github_rate_limited"
  | "github_unavailable"
  | "queue_full"
  | "admission_limited"
  | "scan_failed"
  | "not_scored"
  | "unauthorized"
  | "invalid_type"
  | "not_found";

/** Human hints keyed by code — kept in one place so docs and responses agree. */
const HINTS: Partial<Record<ApiErrorCode, string>> = {
  invalid_body: "Send a JSON body, e.g. {\"username\":\"octocat\"}.",
  invalid_username: "Pass a valid GitHub login (letters, digits, single hyphens).",
  turnstile_failed: "Complete the browser verification, or call with a Bearer API key.",
  rate_limited: "Slow down and retry after the Retry-After interval.",
  rate_limit_unavailable: "Request protection is temporarily unavailable — retry after the Retry-After interval.",
  account_not_found: "That GitHub login does not exist.",
  github_rate_limited: "GitHub's API is rate limited right now — retry shortly.",
  github_unavailable: "GitHub is temporarily unavailable — retry later.",
  queue_full: "Historical scan capacity is busy — retry after the Retry-After interval.",
  admission_limited: "Too many new historical scans from this source — retry after the Retry-After interval.",
  not_scored: "Score the account first (POST /api/scan or GET /api/score/{username}).",
  unauthorized: "Provide a valid Bearer API key.",
  invalid_type: "type must be one of language, org, repo.",
  not_found: `Unknown API path. See ${SITE_URL}/openapi.json for every available endpoint.`,
};

const RESOURCE_METADATA = `${SITE_URL}/.well-known/oauth-protected-resource`;

/** Build a `WWW-Authenticate: Bearer ...` header pointing at the PRM document. */
export function wwwAuthenticateHeader(): string {
  return `Bearer realm="ghfind", resource_metadata="${RESOURCE_METADATA}"`;
}

/**
 * Return a structured JSON error. `error` is the machine code; `message`/`hint`
 * are human-readable. Extra response headers (Retry-After, RateLimit-*,
 * WWW-Authenticate) can be merged in via `headers`.
 */
export function apiError(
  code: ApiErrorCode,
  opts: {
    status: number;
    message?: string;
    hint?: string;
    headers?: Record<string, string>;
  },
): NextResponse {
  const body = {
    error: code,
    message: opts.message ?? code.replace(/_/g, " "),
    hint: opts.hint ?? HINTS[code],
  };
  const headers = { ...(opts.headers ?? {}) };
  if (opts.status === 401 && !headers["WWW-Authenticate"]) {
    headers["WWW-Authenticate"] = wwwAuthenticateHeader();
  }
  return NextResponse.json(body, { status: opts.status, headers });
}
