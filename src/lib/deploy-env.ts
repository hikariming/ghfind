/**
 * Platform-neutral deployment environment.
 *
 * Vercel injects `VERCEL_ENV`; on Cloudflare Workers the deployment sets
 * `GHFIND_DEPLOY_ENV` explicitly (wrangler.jsonc vars, per env). The explicit
 * variable wins so a value baked at build time can't shadow the platform's.
 * Anything other than production/preview (including absent) is development.
 */
export function deployEnv(): "production" | "preview" | "development" {
  const value = process.env.GHFIND_DEPLOY_ENV || process.env.VERCEL_ENV;
  return value === "production" || value === "preview" ? value : "development";
}

export function isProductionDeployment(): boolean {
  return deployEnv() === "production";
}
