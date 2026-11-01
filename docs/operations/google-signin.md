# Google sign-in

The website supports Google OAuth/OpenID Connect alongside GitHub. The login
dialog offers only providers whose server credentials are configured at runtime.
Apple is not enabled; it requires a separate Apple Developer setup.

## Identity and access

Google authenticates a visitor using its stable `sub`, not an email address or a
GitHub username. The signed, HttpOnly `ghfind_session` cookie stores the provider,
subject, display name, optional HTTPS avatar and a 30-day expiry. Google email,
access tokens and refresh tokens are not persisted. Signing out clears the cookie.
Signing in with another provider replaces the current session.

`GET /api/me` exposes `account` for a signed-in identity and `providers` for
available login choices. Its existing `user` and `oauth` fields retain their
GitHub meanings. A Google session has `user: null` and `scored: false`.

GitHub-dependent features (including follows, comments, résumés, account tokens
and repository/Bot permissions) still require GitHub authentication. The account
menu offers **Switch to GitHub**. This release does not link identities, merge
accounts by matching email or assign synthetic GitHub IDs.

## Google configuration

1. Create a dedicated Google Cloud project. A billing account is not required
   for this direct OAuth integration. Do not enable Identity Platform, SMS
   authentication or unrelated paid APIs.
2. In Google Auth Platform, configure the app's branding and external audience.
   Use `https://ghfind.com` as the homepage and
   `https://ghfind.com/privacy` as the privacy policy. The application owner must
   accept Google's User Data Policy. Only request `openid email profile`.
3. Create an OAuth client of type **Web application**, with this exact authorized
   redirect URI: `https://ghfind.com/api/auth/callback/google`.
   For local development, add
   `http://localhost:3000/api/auth/callback/google` if using port 3000.
4. Save the client ID as `AUTH_GOOGLE_ID` and the client secret as
   `AUTH_GOOGLE_SECRET`. Keep the existing `AUTH_SECRET`; rotating it would also
   invalidate existing signed sessions and other signed site tokens.
5. Set both Google secrets on **ghfind-api** (the production auth handler) and
   **ghfind** (the legacy fallback). Do not expose them as `NEXT_PUBLIC_*`, put
   them in source control, or upload them to the static `ghfind-web` Worker.
   GitHub Actions secrets are unnecessary unless a deployment workflow explicitly
   reads them. A GitHub secret by itself does not configure a running Worker.
6. Confirm the OAuth audience is ready for the intended users. Test mode or a
   Workspace administrator's restrictions can limit who signs in. Follow any
   branding/domain verification requirements shown by Google before announcing
   the feature as publicly available.

For local development, set both `NEXT_PUBLIC_SITE_URL` and `PUBLIC_SITE_URL` to
the same local origin and use matching redirect credentials. Production callbacks
are derived from the configured site origin, never a browser-supplied Host header.

Google start and callback routes are registered in both `apps/api/src/routes.ts`
and `apps/router/src/routes.ts`; deploying only the Next app is insufficient.

## Cost boundary

This is direct Google OAuth/OIDC, using a free Google Cloud project. It does not
enable the separate Identity Platform service, whose pricing includes monthly
active users and SMS. Keep the project unlinked from billing if it is only used
for this login flow.

The site's existing Cloudflare charges still apply: a login uses Worker requests
and CPU for the authorization redirect, code exchange and signed ID-token
validation. Google signing keys are cached within each Worker isolate for up to
10 minutes, with refresh cooldowns. Network calls have timeouts and bounded
response bodies. The existing DO/Upstash limiter allows up to 30 Google token
exchanges per minute per client IP after state validation. This can add normal
limiter usage; it creates no new paid service. Production limiter outages stop
exchanges, while local development follows the existing limiter's allowances.
This is not a guarantee of zero hosting costs under heavy or
abusive traffic; monitor the existing Worker request/CPU metrics.

Sources:

- [Google's sign-in setup tutorial](https://codelabs.developers.google.com/codelabs/sign-in-with-google-button)
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Separate Identity Platform pricing](https://cloud.google.com/identity-platform/pricing)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)

## Verification and recovery

- `GET /api/me` should report `providers.google: true` only after all credentials
  are installed. The response is `no-store` and contains no credentials.
- Test the whole flow with an actual Google account: start from the login dialog,
  select an account, return to the original page, inspect the account menu and
  sign out. Also cancel consent and retry from the localized error dialog.
- Verify a Google session cannot access GitHub-authenticated endpoints. Unit
  tests cover real signed JWT validation, state, nonce, PKCE, wrong issuer or
  audience, expired tokens, unsafe redirects and session isolation.
- Check the dialog and menu in Light, Dark and Auto, on desktop and mobile.
- To disable Google only, remove its credentials from both auth Workers. For an
  emergency UI/Google-flow stop, set `GHFIND_OAUTH_ENABLED=0`. Existing sessions
  are not revoked by hiding providers. Do not rotate `AUTH_SECRET` casually.

Callback failures return fixed, non-sensitive `auth_error` codes. Raw provider
responses, authorization codes and tokens must never be added to application logs.
The `oauth_google_failed` application event contains only an allowlisted failure
stage, reason and optional upstream HTTP status. Use it to distinguish token
exchange, Google key retrieval, token validation and session creation failures;
do not export request URLs from callback traces because they contain one-use codes.

Verify provider fetches in the deployed Worker runtime as well as Node tests.
The project's Worker runtime rejects `redirect: "error"`; both Google endpoints
use `redirect: "manual"` and reject non-200 responses so credentials are never
forwarded to a redirected endpoint.
