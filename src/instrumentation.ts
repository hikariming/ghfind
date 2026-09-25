export async function register(): Promise<void> {
  // Local `next dev` has no Workerd runtime, so emulate Cloudflare bindings
  // from wrangler.jsonc, but always use local bindings. This keeps startup
  // independent from Cloudflare login and prevents local requests reaching
  // remote D1. (next.config.ts cannot await; it is require()d.)
  // CI (including the local Feed E2E harness, which always sets CI=true) has no
  // Cloudflare credentials and wires its own Miniflare bindings.
  if (process.env.NODE_ENV === "development" && process.env.NEXT_RUNTIME === "nodejs" && !process.env.CI) {
    const { initOpenNextCloudflareForDev } = await import("@opennextjs/cloudflare");
    await initOpenNextCloudflareForDev({ remoteBindings: false });
  }
}
