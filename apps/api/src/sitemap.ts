/**
 * /sitemap.xml for the API Worker. The Next app builds it from a metadata
 * route (src/app/sitemap.ts → an array Next serializes); this runs the same
 * function through Next's own serializer, so the XML is byte-identical, and
 * keeps the result in the read-model cache for an hour (the Next ISR window):
 * generation reads every public profile, so it must never run per request.
 */
import sitemap from "@/app/sitemap";
import { resolveSitemap } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import { getCachedSitemapXml, setCachedSitemapXml } from "@/lib/redis";

let inflight: Promise<string> | null = null;

async function render(): Promise<string> {
  const cached = await getCachedSitemapXml();
  if (cached) return cached;
  inflight ??= (async () => {
    try {
      const xml = resolveSitemap(await sitemap());
      await setCachedSitemapXml(xml);
      return xml;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function GET() {
  return new Response(await render(), {
    headers: {
      "Content-Type": "application/xml",
      // What the Next Worker sends for its ISR-cached metadata routes.
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}
