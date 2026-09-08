import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
declare global {
  // Wrangler owns Env; this declaration augments only test-only bindings.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      TEST_CORE_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}
await applyD1Migrations(env.FEED_DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.CORE_DB, env.TEST_CORE_MIGRATIONS);
