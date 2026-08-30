import "server-only";
import { oauthConfigured as sessionSecretsConfigured } from "@/lib/oauth-session";

/**
 * Whether the (now in-app) GitHub OAuth flow can be offered by the UI.
 * `GHFIND_OAUTH_ENABLED=0` stays as the emergency login-UI kill switch.
 */
export function oauthConfigured(): boolean {
  return sessionSecretsConfigured() && process.env.GHFIND_OAUTH_ENABLED?.trim() !== "0";
}
