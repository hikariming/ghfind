/**
 * `@opennextjs/cloudflare` shim: src/lib reads bindings through
 * `getCloudflareContext().env`; in this Worker they come from the
 * `cloudflare:workers` env import (same as apps/api).
 */
import { env } from "cloudflare:workers";

export function getCloudflareContext() {
  return { env };
}
