import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The public API stays same-origin throughout extraction. Vercel performs a
 * transparent rewrite to the Go service; no browser sees the private backend
 * origin and no Next route executes business logic for migrated paths.
 *
 * Keep this as an explicit allowlist because several `/api/*` byte renderers
 * intentionally stay in Next while their data reads move to Go.
 */
function backendOrigin(): string | null {
  const raw = process.env.GHFIND_BACKEND_ORIGIN?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

const nextConfig: NextConfig = {
  // Next's default serverExternalPackages list includes @libsql/client, which
  // leaves it un-bundled — on Cloudflare Workers that external require fails
  // at runtime. Force it into the server bundle instead (its /web entry is
  // pure fetch/WebSocket, safe on every runtime we deploy to).
  transpilePackages: ["@libsql/client"],
  // A stray lockfile in the home dir makes Next infer the wrong workspace root.
  // Pin it to this project.
  turbopack: {
    root: __dirname,
  },
  // NOTE: the agent RFC-8288 Link header is set on the markdown/doc route
  // responses (src/lib/agent-docs.ts AGENT_LINK_HEADER) and appended to HTML
  // pages by the middleware (src/proxy.ts) — not here, because next.config
  // headers() is defeated by the locale rewrite.
  async rewrites() {
    const backend = backendOrigin();
    return {
      beforeFiles: backend
        ? [
            // Go-owned public routes plus authenticated job admission/status.
            // The Go origin is server-side only (`GHFIND_BACKEND_ORIGIN`), and
            // Vercel retains `/api/*` as the stable external surface for SDKs
            // and OAuth. `beforeFiles` is deliberate: these rewrites must win
            // over the fail-closed app route files left as deployment guards.
            { source: "/api/projects", destination: `${backend}/api/projects` },
            { source: "/api/projects/:path*", destination: `${backend}/api/projects/:path*` },
            { source: "/api/profile/:path*", destination: `${backend}/api/profile/:path*` },
            { source: "/api/embed/:path*", destination: `${backend}/api/embed/:path*` },
            { source: "/api/sitemap", destination: `${backend}/api/sitemap` },
            { source: "/api/vs/:path*", destination: `${backend}/api/vs/:path*` },
            { source: "/api/scan/jobs/:path*", destination: `${backend}/api/scan/jobs/:path*` },
            { source: "/api/scan", destination: `${backend}/api/scan` },
            { source: "/api/roast", destination: `${backend}/api/roast` },
            { source: "/api/project-analyses", destination: `${backend}/api/project-analyses` },
            { source: "/api/project-analyses/:path*", destination: `${backend}/api/project-analyses/:path*` },
            { source: "/api/project-boards", destination: `${backend}/api/project-boards` },
            { source: "/api/internal/:path*", destination: `${backend}/api/internal/:path*` },
            { source: "/api/admin/:path*", destination: `${backend}/api/admin/:path*` },
          ]
        : [],
      afterFiles: [
        // Markdown twin for blog posts: /blog/{slug}.md -> the raw-markdown handler.
        { source: "/blog/:slug.md", destination: "/blog-md/:slug" },
        { source: "/en/blog/:slug.md", destination: "/blog-md/:slug" },
      ],
    };
  },
};

export default withNextIntl(nextConfig);
