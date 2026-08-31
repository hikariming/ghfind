/**
 * Platform-neutral deployment environment.
 *
 * On Cloudflare Workers each deployment sets `GHFIND_DEPLOY_ENV` explicitly
 * (wrangler.jsonc vars, per env); local dev has no value. Anything other than
 * production/preview (including absent) is development.
 */
export function deployEnv(): "production" | "preview" | "development" {
  const value = process.env.GHFIND_DEPLOY_ENV;
  return value === "production" || value === "preview" ? value : "development";
}

export function isProductionDeployment(): boolean {
  return deployEnv() === "production";
}
