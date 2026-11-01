import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import {
  decodeSignedPayload,
  encodeSignedPayload,
  OAUTH_STATE_TTL_SECONDS,
  safeOAuthCallback,
} from "@/lib/oauth-session";
import { SITE_URL } from "@/lib/site";

export const GOOGLE_STATE_COOKIE = "ghfind_google_state";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const RESPONSE_LIMIT = 64 * 1024;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;

export type GoogleOAuthState = {
  provider: "google";
  state: string;
  nonce: string;
  verifier: string;
  callback_to: string;
  expires_at: number;
};

export type GoogleIdentity = { subject: string; name: string; image: string | null };

type FailureStage = "configuration" | "token_exchange" | "token_response" | "jwks_fetch" | "id_token" | "identity" | "unknown";
type FailureReason = "missing_credentials" | "invalid_code" | "request_failed" | "http_error" |
  "response_too_large" | "missing_response_body" | "response_read_failed" | "invalid_json" |
  "missing_id_token" | "signature_invalid" | "token_expired" | "claims_invalid" |
  "no_matching_key" | "invalid_keys" | "verification_failed" | "audience_mismatch" |
  "presenter_mismatch" | "nonce_mismatch" | "invalid_subject" | "unexpected_error";
export type GoogleOAuthFailureDetails = { stage: FailureStage; reason: FailureReason; status?: number };

class GoogleOAuthFailure extends Error {
  constructor(readonly details: GoogleOAuthFailureDetails) {
    super("google_oauth_failed");
  }
}

/** Only values constructed here may enter logs; never forward an upstream error. */
export function googleOAuthFailureDetails(error: unknown): GoogleOAuthFailureDetails {
  return error instanceof GoogleOAuthFailure
    ? { ...error.details }
    : { stage: "unknown", reason: "unexpected_error" };
}

function fail(stage: FailureStage, reason: FailureReason, status?: number): never {
  throw new GoogleOAuthFailure({ stage, reason, ...(status !== undefined ? { status } : {}) });
}

async function boundedBody(response: Response, stage: "token_response" | "jwks_fetch"): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) {
    await response.body?.cancel().catch(() => {});
    fail(stage, "response_too_large");
  }
  if (!response.body) fail(stage, "missing_response_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => {});
        fail(stage, "response_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GoogleOAuthFailure) throw error;
    fail(stage, "response_read_failed");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

// One cached resolver per Worker isolate: login does not fetch certificates on
// every request. Only this fixed Google endpoint can supply verification keys;
// token-controlled jku/x5u headers and client-controlled URLs are never used.
const googleKeys = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60_000,
  [customFetch]: async (url, options) => {
    let response: Response;
    try {
      // workerd rejects redirect:"error" while constructing the Request.
      // Manual mode plus the exact status check also prevents key redirects.
      response = await fetch(url, { ...options, redirect: "manual" });
    } catch {
      fail("jwks_fetch", "request_failed");
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      fail("jwks_fetch", "http_error", response.status);
    }
    return new Response(await boundedBody(response, "jwks_fetch"), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  },
});

function clientId(): string {
  const value = process.env.AUTH_GOOGLE_ID?.trim();
  if (!value) fail("configuration", "missing_credentials");
  return value;
}

export function newGoogleOAuthState(callbackTo: string): {
  cookie: string;
  state: GoogleOAuthState;
} {
  const callback = safeOAuthCallback(callbackTo, SITE_URL);
  const state: GoogleOAuthState = {
    provider: "google",
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    callback_to: callback.length <= 2_048 ? callback : "/",
    expires_at: Date.now() + OAUTH_STATE_TTL_SECONDS * 1_000,
  };
  return { cookie: encodeSignedPayload("oidc-state", state), state };
}

export function readGoogleOAuthState(raw: string | undefined): GoogleOAuthState | null {
  if (!raw || raw.length > 8_192) return null;
  const value = decodeSignedPayload<GoogleOAuthState>("oidc-state", raw);
  if (
    !value || value.provider !== "google" ||
    typeof value.state !== "string" || !RANDOM_VALUE.test(value.state) ||
    typeof value.nonce !== "string" || !RANDOM_VALUE.test(value.nonce) ||
    typeof value.verifier !== "string" || !RANDOM_VALUE.test(value.verifier) ||
    typeof value.callback_to !== "string" || value.callback_to.length > 2_048 ||
    !Number.isSafeInteger(value.expires_at) || value.expires_at <= Date.now() ||
    value.expires_at > Date.now() + OAUTH_STATE_TTL_SECONDS * 1_000 ||
    safeOAuthCallback(value.callback_to, SITE_URL) !== value.callback_to
  ) return null;
  return value;
}

export function googleStateMatches(given: string | null, state: GoogleOAuthState): boolean {
  if (!given || !RANDOM_VALUE.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, "ascii"), Buffer.from(state.state, "ascii"));
}

export function googleAuthorizationUrl(state: GoogleOAuthState): URL {
  const authorize = new URL(GOOGLE_AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: `${SITE_URL}/api/auth/callback/google`,
    response_type: "code",
    scope: "openid email profile",
    state: state.state,
    nonce: state.nonce,
    code_challenge: createHash("sha256").update(state.verifier, "ascii").digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return authorize;
}

function displayName(value: unknown): string {
  if (typeof value !== "string") return "Google user";
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 128) || "Google user";
}

function profileImage(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2_048 ? url.href : null;
  } catch {
    return null;
  }
}

/** Exchange a single-use code and validate the signed identity, never its email. */
export async function exchangeGoogleCode(code: string, state: GoogleOAuthState): Promise<GoogleIdentity> {
  const id = clientId();
  const secret = process.env.AUTH_GOOGLE_SECRET?.trim();
  if (!secret) fail("configuration", "missing_credentials");
  if (!code || code.length > 4_096) fail("token_exchange", "invalid_code");
  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${SITE_URL}/api/auth/callback/google`,
        code_verifier: state.verifier,
      }),
      // Never forward the client secret to a redirect target. Cloudflare supports
      // manual redirect handling even when its Request rejects "error" mode.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    fail("token_exchange", "request_failed");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    fail("token_exchange", "http_error", response.status);
  }
  const body = await boundedBody(response, "token_response");
  let token: unknown;
  try { token = JSON.parse(body); } catch { fail("token_response", "invalid_json"); }
  if (!token || typeof token !== "object" || !("id_token" in token) || typeof token.id_token !== "string" || token.id_token.length > 16_384) fail("token_response", "missing_id_token");
  let payload;
  try {
    ({ payload } = await jwtVerify(token.id_token, googleKeys, {
      algorithms: ["RS256"],
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: id,
      requiredClaims: ["iss", "aud", "exp", "iat", "sub", "nonce"],
      maxTokenAge: "10 minutes",
      clockTolerance: 5,
    }));
  } catch (error) {
    if (error instanceof GoogleOAuthFailure) throw error;
    const reasonByCode: Record<string, FailureReason> = {
      ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "signature_invalid",
      ERR_JWT_EXPIRED: "token_expired",
      ERR_JWT_CLAIM_VALIDATION_FAILED: "claims_invalid",
      ERR_JWKS_NO_MATCHING_KEY: "no_matching_key",
      ERR_JWKS_INVALID: "invalid_keys",
    };
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
    const reason = Object.hasOwn(reasonByCode, code) ? reasonByCode[code] : "verification_failed";
    fail("id_token", reason);
  }
  if (payload.aud !== id) fail("identity", "audience_mismatch");
  if (payload.azp !== undefined && payload.azp !== id) fail("identity", "presenter_mismatch");
  if (payload.nonce !== state.nonce) fail("identity", "nonce_mismatch");
  if (typeof payload.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(payload.sub)) fail("identity", "invalid_subject");
  return { subject: payload.sub, name: displayName(payload.name), image: profileImage(payload.picture) };
}
