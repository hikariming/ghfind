import "./runtime-compat";
import { Hono } from "hono";
import * as apiNotFound from "@/app/api/[...notFound]/route";
import { NextRequest } from "next/server";
import { API_ROUTES } from "./routes";
import { requestContext } from "./request-context";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;

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
    // Assigning over an existing c.res makes Hono copy the old headers onto
    // the new response, restoring e.g. a handler's `no-store`; reset first.
    c.res = undefined;
    c.res = res;
  }
});

// Route modules answer like Next route handlers do: HEAD via GET when no HEAD
// is exported, OPTIONS 204 with an Allow list of the implemented methods, any
// other method a bare 405 (Next sends no Allow header there).
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"] as const;

for (const route of API_ROUTES) {
  const mod = route.module as Partial<Record<(typeof METHODS)[number] | "OPTIONS", Handler>>;
  const implemented = METHODS.filter((m) => typeof mod[m] === "function");
  const allow = [...new Set(["OPTIONS", ...implemented, ...(mod.GET ? ["HEAD"] : [])])].sort().join(", ");

  app.all(route.path, async (c) => {
    const method = c.req.method;
    const handler = mod[method as keyof typeof mod] ?? (method === "HEAD" ? mod.GET : undefined);
    if (!handler) {
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: allow } });
      return new Response(null, { status: 405 });
    }
    // Handlers get Next's own NextRequest (nextUrl, cookies) and, like Next,
    // dynamic segments as `{ params: Promise<...> }`; next/headers and `after`
    // read the request context.
    const req = new NextRequest(c.req.raw);
    const context = { request: c.req.raw, waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p) };
    const res = await requestContext.run(context, () => handler(req, { params: Promise.resolve(route.params ? route.params(c.req.param()) : c.req.param()) }));
    // NextResponse.cookies mirrors every Set-Cookie into this internal header;
    // Next's send-response drops it on the way out, so do the same.
    if (res.headers.has("x-middleware-set-cookie")) {
      const out = new Response(res.body, res);
      out.headers.delete("x-middleware-set-cookie");
      return out;
    }
    return res;
  });
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
