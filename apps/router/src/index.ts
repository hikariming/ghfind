import { pickTarget } from "./routes";

export interface Env {
  WEB: Fetcher;
  API: Fetcher;
  LEGACY: Fetcher;
  /** "1" sends every request to the legacy Worker (instant rollback via a var change). */
  ROUTER_FORCE_LEGACY?: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const target = env.ROUTER_FORCE_LEGACY === "1" ? "legacy" : pickTarget(pathname);
    const upstream = target === "web" ? env.WEB : target === "api" ? env.API : env.LEGACY;
    // Service bindings keep the original URL/host, so both apps see the
    // public origin exactly as they did behind the custom domain.
    const res = await upstream.fetch(request);
    const out = new Response(res.body, res);
    out.headers.set("X-Ghfind-Origin", target);
    return out;
  },
} satisfies ExportedHandler<Env>;
