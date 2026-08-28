// OpenNext → Cloudflare Workers adapter config.
// ISR pages persist in R2 (binding NEXT_INC_CACHE_R2_BUCKET, see wrangler.jsonc)
// so revalidated HTML survives isolate recycling — the closest analogue to
// Vercel's ISR cache. No revalidateTag/Path in the codebase, so no tag cache.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({
  incrementalCache: r2IncrementalCache,
});
