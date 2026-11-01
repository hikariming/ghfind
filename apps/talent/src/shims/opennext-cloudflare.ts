/**
 * `@opennextjs/cloudflare` shim (wired via the wrangler `alias`): src/lib reads
 * bindings through `getCloudflareContext().env`; in this plain Worker they come
 * from the `cloudflare:workers` env import.
 */
import { env } from "cloudflare:workers";

export function getCloudflareContext() {
  return { env, ctx: undefined };
}
