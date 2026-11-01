import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

// Use the API Worker's pinned Wrangler runtime. No additional packages, remote
// bindings, real provider calls, or production credentials are needed.
const appRequire = createRequire(new URL("../apps/api/package.json", import.meta.url));
const wranglerRequire = createRequire(appRequire.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { build } = wranglerRequire("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const clientId = "local-runtime-test.apps.googleusercontent.com";
const nonce = "n".repeat(43);
const verifier = "v".repeat(43);
const tokenUrl = "https://oauth2.googleapis.com/token";
const keysUrl = "https://www.googleapis.com/oauth2/v3/certs";

test("Google OAuth constructs real workerd requests, verifies identity, and refuses redirects", { timeout: 30_000 }, async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...await exportJWK(publicKey), kid: "local-runtime-key", alg: "RS256", use: "sig" };
  const now = Math.floor(Date.now() / 1_000);
  const token = await new SignJWT({
    iss: "https://accounts.google.com", aud: clientId, sub: "local-runtime-subject",
    nonce, name: "Local runtime user", iat: now, exp: now + 300,
  }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).sign(privateKey);
  const bundled = await build({
    absWorkingDir: root,
    stdin: {
      contents: `
        import { exchangeGoogleCode, googleOAuthFailureDetails } from "./src/lib/google-oauth.ts";
        export default { async fetch() {
          const state = {
            provider: "google", state: "s".repeat(43), nonce: ${JSON.stringify(nonce)},
            verifier: ${JSON.stringify(verifier)}, callback_to: "/", expires_at: Date.now() + 600000,
          };
          try { return Response.json(await exchangeGoogleCode("local-code", state)); }
          catch (error) { return Response.json(googleOAuthFailureDetails(error), { status: 502 }); }
        }};
      `,
      resolveDir: root,
      sourcefile: "google-oauth-runtime-fixture.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*"],
    logLevel: "silent",
  });

  for (const mode of ["success", "token_redirect", "keys_redirect"]) {
    const requests = [];
    const runtime = new Miniflare(convertV4MiniflareOptions({
      name: "google-oauth-test",
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-08-06",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        AUTH_GOOGLE_ID: clientId,
        AUTH_GOOGLE_SECRET: "local-runtime-secret",
        AUTH_SECRET: "local-runtime-session-secret",
        PUBLIC_SITE_URL: "https://ghfind.com",
        NEXT_PUBLIC_SITE_URL: "https://ghfind.com",
      },
      outboundService: async request => {
        requests.push(request.url);
        if (request.url === tokenUrl) {
          assert.equal(request.method, "POST");
          const form = new URLSearchParams(await request.text());
          assert.equal(form.get("client_id"), clientId);
          assert.equal(form.get("client_secret"), "local-runtime-secret");
          assert.equal(form.get("code_verifier"), verifier);
          assert.equal(form.get("redirect_uri"), "https://ghfind.com/api/auth/callback/google");
          return mode === "token_redirect"
            ? new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid/" } })
            : Response.json({ id_token: token });
        }
        if (request.url === keysUrl) {
          return mode === "keys_redirect"
            ? new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid/" } })
            : Response.json({ keys: [jwk] });
        }
        assert.fail("Unexpected outbound request: fixed provider fixture endpoints only");
      },
    }));
    try {
      const response = await runtime.dispatchFetch("https://local-runtime.invalid/");
      const result = await response.json();
      if (mode === "success") {
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.deepEqual(result, { subject: "local-runtime-subject", name: "Local runtime user", image: null });
        assert.deepEqual(requests, [tokenUrl, keysUrl]);
      } else {
        assert.equal(response.status, 502);
        assert.deepEqual(result, {
          stage: mode === "token_redirect" ? "token_exchange" : "jwks_fetch",
          reason: "http_error", status: 302,
        });
        assert.deepEqual(requests, mode === "token_redirect" ? [tokenUrl] : [tokenUrl, keysUrl]);
      }
    } finally {
      await runtime.dispose();
    }
  }
});
