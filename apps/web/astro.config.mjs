// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

/** @param {string} p */
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Pages SSR on the Worker and set their own Cache-Control for the edge.
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  integrations: [react()],
  // No server sessions: state lives in the API Worker's cookies. Without this
  // the adapter auto-provisions a SESSION KV namespace on deploy.
  session: false,
  // "ignore" so middleware can 308 `/x/` → `/x` like Next (with "never" Astro
  // 404s the slash form before middleware runs).
  trailingSlash: "ignore",
  devToolbar: { enabled: false },
  // The repo's public/ (fonts, icons, install.sh, docs, images): served from
  // this Worker's asset layer (the router sends every non-API path here).
  publicDir: "../../public",
  vite: {
    plugins: [tailwindcss()],
    server: {
      // In production the router sends /api to the API/legacy Worker; locally,
      // borrow the dev deployment so islands (/api/me, sponsors) work.
      proxy: Object.fromEntries(
        ["/api"].map((p) => [
          p,
          { target: process.env.LEGACY_ORIGIN ?? "https://ghfind-dev.beiming1201.workers.dev", changeOrigin: true },
        ]),
      ),
    },
    resolve: {
      alias: [
        // Shared React components from the Next app run as islands through
        // these shims (order matters: specific aliases before `@/`).
        { find: /^next-intl$/, replacement: here("./src/shims/next-intl.tsx") },
        { find: /^@\/i18n\/navigation$/, replacement: here("./src/shims/navigation.tsx") },
        { find: /^next\/navigation$/, replacement: here("./src/shims/next-navigation.tsx") },
        { find: /^next\/headers$/, replacement: here("./src/shims/next-headers.ts") },
        { find: /^@opennextjs\/cloudflare$/, replacement: here("./src/shims/opennext-cloudflare.ts") },
        { find: /^server-only$/, replacement: here("./src/shims/server-only.ts") },
        { find: /^@\//, replacement: here("../../src/") },
      ],
    },
  },
});
