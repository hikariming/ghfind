import type { APIRoute } from "astro";
import { loadFeedItemDetail, parseThread } from "@/lib/pages/feed-item";
import { routeLocale } from "../../../lib/i18n";

/** Lazy detail + comment thread for one /feed item (see src/lib/pages/feed-item.ts). */
export const GET: APIRoute = async ({ params, url }) => {
  const locale = routeLocale(params.locale);
  const id = url.searchParams.get("id") ?? "";
  if (!locale || id.length > 200) return new Response(null, { status: 404 });
  const detail = await loadFeedItemDetail(id, locale, parseThread(url.searchParams.get("thread")));
  if (!detail) return new Response(null, { status: 404 });
  return Response.json(detail, {
    headers: {
      // Short shared cache: comments posted from the stream are also kept client-side.
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      "X-Robots-Tag": "noindex",
    },
  });
};
