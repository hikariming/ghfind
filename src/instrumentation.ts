export async function register(): Promise<void> {
  // Local `next dev` has no Workerd runtime, so Cloudflare bindings must be
  // emulated from wrangler.jsonc. Awaiting matters: the top-level D1 bindings
  // use remote mode and take seconds to connect, and the data layer's Turso
  // fallback is decommissioned — serving requests before this resolves sends
  // them to a dead database. (next.config.ts cannot await; it is require()d.)
  if (process.env.NODE_ENV === "development" && process.env.NEXT_RUNTIME === "nodejs") {
    const { initOpenNextCloudflareForDev } = await import("@opennextjs/cloudflare");
    await initOpenNextCloudflareForDev();
  }
}
