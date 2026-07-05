import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
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
    return [
      // Markdown twin for blog posts: /blog/{slug}.md → the raw-markdown handler.
      { source: "/blog/:slug.md", destination: "/blog-md/:slug" },
      { source: "/en/blog/:slug.md", destination: "/blog-md/:slug" },
    ];
  },
};

export default withBotId(withNextIntl(nextConfig));
