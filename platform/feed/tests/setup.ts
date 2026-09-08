import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}
await applyD1Migrations(env.FEED_DB, env.TEST_MIGRATIONS);
