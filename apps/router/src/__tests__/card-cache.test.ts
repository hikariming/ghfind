import { afterEach, describe, expect, it, vi } from "vitest";
import { CARD_CACHE_HEADER, cardRequest, resetCardIsolate, serveCard } from "../card-cache";
import router, { type Env } from "../index";

const card = (path: string) => cardRequest(new URL(`https://ghfind.com${path}`));
const canonical = (path: string) => card(path)?.canonical.toString().replace("https://ghfind.com", "");

describe("cardRequest", () => {
  it("ignores non-card paths", () => {
    expect(card("/u/octocat")).toBeNull();
    expect(card("/api/leaderboard")).toBeNull();
    expect(card("/api/card/mini/a/b")).toBeNull();
  });

  it("keys a card by the params that change its output, defaults dropped", () => {
    expect(canonical("/api/card/mini/octocat")).toBe("/api/card/mini/octocat");
    expect(canonical("/api/card/mini/octocat?v=1728000000&theme=auto&variant=bars&lang=en")).toBe(
      "/api/card/mini/octocat",
    );
    expect(canonical("/api/card/mini/octocat?lang=zh&variant=radar&theme=dark&utm_source=x")).toBe(
      "/api/card/mini/octocat?lang=zh&theme=dark&variant=radar",
    );
    expect(canonical("/api/card/octocat?theme=dark&variant=score&qr=0")).toBe("/api/card/octocat");
    expect(canonical("/api/card/octocat?qr=true&theme=light&variant=pr")).toBe(
      "/api/card/octocat?qr=1&theme=light&variant=pr",
    );
    expect(canonical("/api/card/vs/a/b?lang=zh&theme=light&cb=9")).toBe("/api/card/vs/a/b?lang=zh&theme=light");
    expect(canonical("/api/badge/octocat?lang=en&v=2")).toBe("/api/badge/octocat");
    expect(canonical("/api/material-card/octocat?theme=light")).toBe("/api/material-card/octocat?theme=light");
    expect(card("/api/card/mini/octocat?v=1")?.redirect).toBe(false);
  });

  it("matches values exactly, like the handlers' parsers", () => {
    expect(canonical("/api/card/mini/octocat?theme=Dark")).toBe("/api/card/mini/octocat");
    expect(canonical("/api/card/mini/octocat?theme=constructor&toString=1")).toBe("/api/card/mini/octocat");
  });

  it("uses the first occurrence of a repeated param", () => {
    expect(canonical("/api/card/mini/octocat?theme=light&theme=dark")).toBe("/api/card/mini/octocat?theme=light");
  });

  it.each([
    ["/api/card/mini/octocat&quot", "/api/card/mini/octocat"],
    ["/api/card/mini/octocat&quot;", "/api/card/mini/octocat"],
    ['/api/card/mini/octocat"', "/api/card/mini/octocat"],
    ["/api/card/mini/octocat%22", "/api/card/mini/octocat"],
    ["/api/card/octocat?theme=light&quot;", "/api/card/octocat?theme=light"],
    ["/api/card/octocat?theme=light&quot=", "/api/card/octocat?theme=light"],
    ["/api/card/mini/octocat?theme=dark%22", "/api/card/mini/octocat?theme=dark"],
    ["/api/card/mini/octocat?theme=dark&quot", "/api/card/mini/octocat?theme=dark"],
    ["/api/card/mini/octocat?variant=radar&amp;theme=light", "/api/card/mini/octocat?theme=light&variant=radar"],
    ["/api/badge/octocat?lang=zh&quot;&v=1", "/api/badge/octocat?lang=zh"],
  ])("redirects the malformed embed %s", (path, clean) => {
    const parsed = card(path);
    expect(parsed?.redirect).toBe(true);
    expect(parsed?.canonical.toString()).toBe(`https://ghfind.com${clean}`);
  });

  it("never caches the material-card preview", () => {
    expect(card("/api/material-card/octocat?preview=1")?.bypass).toBe(true);
    expect(card("/api/material-card/octocat")?.bypass).toBe(false);
  });
});

const CDN_CACHE = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";

function api(cacheControl: string | null = CDN_CACHE, status = 200) {
  const urls: string[] = [];
  const fetcher = {
    fetch: async (request: Request) => {
      urls.push(request.url);
      return new Response(`<svg>${new URL(request.url).search}</svg>`, {
        status,
        headers: { "Content-Type": "image/svg+xml", ...(cacheControl ? { "Cache-Control": cacheControl } : {}) },
      });
    },
  } as unknown as Fetcher;
  return { fetcher, urls };
}

describe("serveCard", () => {
  afterEach(() => {
    resetCardIsolate();
    vi.useRealTimers();
  });

  it("renders once per canonical URL and serves cache-busted variants from the isolate", async () => {
    const upstream = api();
    const get = (path: string) => serveCard(new Request(`https://ghfind.com${path}`), card(path)!, upstream.fetcher);

    const first = await get("/api/card/mini/octocat?theme=dark&v=1");
    expect(first.headers.get(CARD_CACHE_HEADER)).toBe("MISS");
    expect(await first.text()).toBe("<svg>?theme=dark</svg>");
    // The handler only ever sees the canonical URL.
    expect(upstream.urls).toEqual(["https://ghfind.com/api/card/mini/octocat?theme=dark"]);

    const second = await get("/api/card/mini/octocat?v=2&theme=dark&utm=readme");
    expect(second.headers.get(CARD_CACHE_HEADER)).toBe("HIT");
    expect(await second.text()).toBe("<svg>?theme=dark</svg>");
    expect(second.headers.get("Cache-Control")).toBe(CDN_CACHE);
    expect(upstream.urls).toHaveLength(1);
  });

  it("does not cache responses the handler keeps out of shared caches", async () => {
    for (const [cacheControl, status] of [
      ["no-store", 200],
      [null, 404],
      ["public, max-age=60", 200],
      ["private, s-maxage=600", 200],
      [CDN_CACHE, 500],
    ] as const) {
      resetCardIsolate();
      const upstream = api(cacheControl, status);
      const path = "/api/material-card/octocat";
      await serveCard(new Request(`https://ghfind.com${path}`), card(path)!, upstream.fetcher);
      await serveCard(new Request(`https://ghfind.com${path}`), card(path)!, upstream.fetcher);
      expect(upstream.urls).toHaveLength(2);
    }
  });

  it("passes the material-card preview straight through", async () => {
    const upstream = api("no-store");
    const path = "/api/material-card/octocat?preview=1";
    const res = await serveCard(new Request(`https://ghfind.com${path}`), card(path)!, upstream.fetcher);
    expect(res.headers.get(CARD_CACHE_HEADER)).toBe("BYPASS");
    expect(upstream.urls).toEqual([`https://ghfind.com${path}`]);
  });

  it("answers HEAD from a cached GET without a body", async () => {
    const upstream = api();
    const path = "/api/badge/octocat";
    await serveCard(new Request(`https://ghfind.com${path}`), card(path)!, upstream.fetcher);
    const head = await serveCard(
      new Request(`https://ghfind.com${path}`, { method: "HEAD" }),
      card(path)!,
      upstream.fetcher,
    );
    expect(head.headers.get(CARD_CACHE_HEADER)).toBe("HIT");
    expect(head.body).toBeNull();
    expect(upstream.urls).toHaveLength(1);
  });

  it("serves a stale card after s-maxage and revalidates in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const urls: string[] = [];
    let finishRefresh: ((res: Response) => void) | undefined;
    const ok = () =>
      new Response("<svg></svg>", {
        status: 200,
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": CDN_CACHE },
      });
    const fetcher = {
      fetch: async (request: Request) => {
        urls.push(request.url);
        if (urls.length === 1) return ok();
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      },
    } as unknown as Fetcher;
    const path = "/api/card/octocat";
    const waits: Promise<unknown>[] = [];
    const get = () =>
      serveCard(new Request(`https://ghfind.com${path}`), card(path)!, fetcher, {
        waitUntil: (promise) => waits.push(promise),
      });

    expect((await get()).headers.get(CARD_CACHE_HEADER)).toBe("MISS");
    expect(urls).toHaveLength(1);

    vi.setSystemTime(1_800_000_000_000 + 21600_000 + 1);
    const stale = await get();
    expect(stale.headers.get(CARD_CACHE_HEADER)).toBe("STALE");
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("<svg></svg>");
    expect(finishRefresh).toBeTypeOf("function");
    expect(urls).toHaveLength(2);
    finishRefresh!(ok());
    await Promise.all(waits);

    vi.setSystemTime(1_800_000_000_000 + 21600_000 + 2);
    const refreshed = await get();
    expect(refreshed.headers.get(CARD_CACHE_HEADER)).toBe("HIT");
    expect(urls).toHaveLength(2);
  });

  it("returns the stale card when origin fails instead of 504", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    let status = 200;
    const urls: string[] = [];
    const fetcher = {
      fetch: async (request: Request) => {
        urls.push(request.url);
        return new Response("<svg></svg>", {
          status,
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": CDN_CACHE },
        });
      },
    } as unknown as Fetcher;
    const path = "/api/card/octocat";
    const get = () => serveCard(new Request(`https://ghfind.com${path}`), card(path)!, fetcher);

    expect((await get()).headers.get(CARD_CACHE_HEADER)).toBe("MISS");
    vi.setSystemTime(1_800_000_000_000 + 21600_000 + 86_400_000 + 1);
    status = 504;
    const stale = await get();
    expect(stale.status).toBe(200);
    expect(stale.headers.get(CARD_CACHE_HEADER)).toBe("STALE");
    expect(await stale.text()).toBe("<svg></svg>");
    expect(urls).toHaveLength(2);
  });

  it("does not invent a card when nothing is cached and origin fails", async () => {
    const upstream = api(CDN_CACHE, 504);
    const path = "/api/card/octocat";
    const res = await serveCard(new Request(`https://ghfind.com${path}`), card(path)!, upstream.fetcher);
    expect(res.status).toBe(504);
    expect(res.headers.get(CARD_CACHE_HEADER)).toBe("MISS");
  });

  it("returns the stale card when origin throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    let fail = false;
    const fetcher = {
      fetch: async () => {
        if (fail) throw new Error("upstream timeout");
        return new Response("<svg></svg>", {
          status: 200,
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": CDN_CACHE },
        });
      },
    } as unknown as Fetcher;
    const path = "/api/card/octocat";
    await serveCard(new Request(`https://ghfind.com${path}`), card(path)!, fetcher);
    vi.setSystemTime(1_800_000_000_000 + 21600_000 + 86_400_000 + 1);
    fail = true;
    const stale = await serveCard(new Request(`https://ghfind.com${path}`), card(path)!, fetcher);
    expect(stale.status).toBe(200);
    expect(stale.headers.get(CARD_CACHE_HEADER)).toBe("STALE");
  });
});

describe("router card handling", () => {
  afterEach(() => resetCardIsolate());

  function env(forceLegacy = "0") {
    const calls: string[] = [];
    const upstream = (name: string) => ({
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        calls.push(`${name} ${url.pathname}${url.search}`);
        return new Response(name, { headers: { "Cache-Control": CDN_CACHE } });
      },
    }) as unknown as Fetcher;
    const e: Env = { WEB: upstream("web"), API: upstream("api"), LEGACY: upstream("legacy"), ROUTER_FORCE_LEGACY: forceLegacy };
    return { env: e, calls };
  }

  it("301s a broken embed to the clean URL without invoking the API Worker", async () => {
    const { env: e, calls } = env();
    const res = await router.fetch(new Request("https://ghfind.com/api/card/mini/octocat?theme=dark&quot;"), e);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://ghfind.com/api/card/mini/octocat?theme=dark");
    expect(res.headers.get("X-Ghfind-Origin")).toBe("router");
    expect(calls).toEqual([]);
  });

  it("serves repeat card requests from the isolate cache", async () => {
    const { env: e, calls } = env();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as ExecutionContext;
    await router.fetch(new Request("https://ghfind.com/api/card/octocat?v=1"), e, ctx);
    await Promise.all(waits);
    const hit = await router.fetch(new Request("https://ghfind.com/api/card/octocat?v=2"), e, ctx);
    expect(hit.headers.get(CARD_CACHE_HEADER)).toBe("HIT");
    expect(hit.headers.get("X-Ghfind-Origin")).toBe("api");
    expect(calls).toEqual(["api /api/card/octocat"]);
  });

  it("leaves everything to the legacy Worker under the rollback switch", async () => {
    const { env: e, calls } = env("1");
    await router.fetch(new Request("https://ghfind.com/api/card/mini/octocat&quot"), e);
    expect(calls).toEqual(["legacy /api/card/mini/octocat&quot"]);
  });
});
