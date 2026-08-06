import "server-only";

/** Whether the Go-owned GitHub OAuth flow can be offered by the UI. */
export function oauthConfigured(): boolean {
  const backend = process.env.GHFIND_BACKEND_ORIGIN?.trim();
  if (!backend) return false;
  try {
    const url = new URL(backend);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  } catch {
    return false;
  }
  return process.env.GHFIND_OAUTH_ENABLED?.trim() !== "0";
}
