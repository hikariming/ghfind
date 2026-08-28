// OpenNext → Cloudflare Workers adapter config.
// Spike/dev: default config (in-memory dummy incremental cache).
// Before production cutover this must switch to the R2 incremental cache —
// see docs/plans/2026-08-28-cloudflare-migration-execution.md 阶段1.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
