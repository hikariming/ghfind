import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * /auth.md — how an agent authenticates to ghfind, in the WorkOS auth.md prose
 * shape (Discover / Pick a method / Register / Claim / Use / Errors / Revocation).
 * Honest by design: ghfind's read surface is public and unauthenticated; the only
 * credential is an optional machine API key for higher scan limits. We do NOT run
 * an OAuth authorization server, so we don't advertise register/claim/revocation
 * endpoints that would 404 under probing. Spec ref: https://workos.com/auth-md
 */
export function buildAuthMd(): string {
  return `# Authenticating to ghfind

Most of ghfind is a **public, read-only, deterministic API** — no credential is
required to score accounts, scan, compare, or read leaderboards. Authentication
exists only to raise rate limits for trusted machine callers.

## Discover

- Protected-resource metadata (RFC 9728): [${SITE_URL}/.well-known/oauth-protected-resource](${SITE_URL}/.well-known/oauth-protected-resource)
- API catalog (RFC 9727): [${SITE_URL}/.well-known/api-catalog](${SITE_URL}/.well-known/api-catalog)
- Machine spec: [${SITE_URL}/openapi.json](${SITE_URL}/openapi.json)

An authenticated request that is rejected returns \`401\` with a
\`WWW-Authenticate: Bearer resource_metadata="${SITE_URL}/.well-known/oauth-protected-resource"\`
header, so an agent learns the requirement from one request.

## Pick a method

| Job | Method |
|---|---|
| Read a score / scan / compare / leaderboard | **No auth.** Call the endpoint directly. |
| High-volume server-to-server scanning | **Bearer API key** in the \`Authorization\` header. |
| Roast with your own model | No account needed — pass \`byoKey\` in the request body. |

There is **no OAuth flow, no \`agent_auth\` dynamic registration, and no
\`identity_assertion\` / \`id-jag\` token exchange** — ghfind does not host an
authorization server. A single static Bearer key is the only credential.

## Register

The Bearer API key is issued out-of-band by the operator (open an issue at
[github.com/hikariming/ghfind/issues](https://github.com/hikariming/ghfind/issues)).
Anonymous access needs no registration and is the intended path for most agents.

## Claim

Set the issued key as the \`GITHUB_ROAST_CLI_API_KEY\` value in your client and
send it as a Bearer token (below). Nothing to claim or exchange.

## Use the credential

\`\`\`bash
curl -s -X POST ${SITE_URL}/api/scan \\
  -H 'Authorization: Bearer <your-api-key>' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: <uuid>' \\
  -d '{"username":"torvalds"}'
\`\`\`

Browser callers instead pass a Cloudflare Turnstile token; machine callers with a
valid Bearer key skip Turnstile. Write calls accept an \`Idempotency-Key\` header;
scans are idempotent per username, so a retried request is safe.

## Errors

All errors are JSON: \`{ "error": "<code>", "message": "...", "hint": "..." }\`.
Relevant codes: \`invalid_body\`, \`invalid_username\`, \`turnstile_failed\` (403),
\`rate_limited\` (429, with \`Retry-After\`), \`account_not_found\` (404),
\`github_unavailable\` (503), \`github_collect_deadline\` (503, short \`Retry-After\`),
\`scan_pending\` (202, \`Retry-After\` and \`Location\` — poll GET /api/scan?username= until 200),
\`scan_busy\` (503). Responses carry \`RateLimit-Limit\`,
\`RateLimit-Remaining\`, and \`RateLimit-Reset\` so you can self-throttle.

## Revocation

Keys are revoked out-of-band by the operator; there is no self-serve revocation
endpoint. Because anonymous access already covers the read surface, revoking a key
only removes the elevated rate limit, never access to the public API.
`;
}

export function GET() {
  return new Response(buildAuthMd(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=86400",
      Vary: "Accept",
    },
  });
}
