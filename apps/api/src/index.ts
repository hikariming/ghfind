import "./runtime-compat";
import { Hono } from "hono";
import * as apiNotFound from "@/app/api/[...notFound]/route";
import { API_ROUTES } from "./routes";

const app = new Hono();

// Parity with the legacy Next Worker, which serves every 404 as uncacheable
// regardless of the handler's own Cache-Control (so e.g. the catch-all's
// `public, s-maxage=3600` never reached the CDN there either).
const NEXT_404_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";
app.use(async (c, next) => {
  await next();
  if (c.res.status === 404) {
    const res = new Response(c.res.body, c.res);
    res.headers.set("Cache-Control", NEXT_404_CACHE_CONTROL);
    c.res = res;
  }
});

// GET-only route modules answer like Next route handlers do: HEAD via GET,
// OPTIONS 204 with an Allow list, anything else a bare 405 (Next sends no
// Allow header there).
const ALLOW = "GET, HEAD, OPTIONS";

for (const route of API_ROUTES) {
  // Next passes dynamic segments as `{ params: Promise<...> }`; mirror that so
  // the shared handlers run unchanged.
  app.get(route.path, (c) => route.GET(c.req.raw, { params: Promise.resolve(c.req.param()) }));
  app.options(route.path, () => new Response(null, { status: 204, headers: { Allow: ALLOW } }));
  app.all(route.path, () => new Response(null, { status: 405 }));
}

// Unknown /api paths get the Next app's structured JSON 404. notFound runs
// outside the middleware chain, so apply the 404 cache policy here too.
app.notFound(() => {
  const res = apiNotFound.GET();
  res.headers.set("Cache-Control", NEXT_404_CACHE_CONTROL);
  return res;
});

app.onError((err) => {
  console.error("api.unhandled", err);
  return Response.json({ error: "internal_error" }, { status: 500 });
});

export default app;
