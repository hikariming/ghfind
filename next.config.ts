import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // A stray lockfile in the home dir makes Next infer the wrong workspace root.
  // Pin it to this project.
  turbopack: {
    root: __dirname,
  },
};

export default withNextIntl(nextConfig);
