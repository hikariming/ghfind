import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

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
    return {
      afterFiles: [
        // Markdown twin for blog posts: /blog/{slug}.md -> the raw-markdown handler.
        { source: "/blog/:slug.md", destination: "/blog-md/:slug" },
        { source: "/en/blog/:slug.md", destination: "/blog-md/:slug" },
      ],
    };
  },
};

export default withNextIntl(nextConfig);
