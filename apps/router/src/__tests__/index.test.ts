import { describe, expect, it } from "vitest";
import router, { type Env } from "../index";

function env(noindex: string): { env: Env; calls: string[] } {
  const calls: string[] = [];
  const upstream = (name: string) => ({
    fetch: async (request: Request) => {
      calls.push(`${name} ${new URL(request.url).pathname}`);
      return new Response(name);
    },
  }) as unknown as Fetcher;
  return {
    env: { WEB: upstream("web"), API: upstream("api"), LEGACY: upstream("legacy"), ROUTER_NOINDEX: noindex },
    calls,
  };
}

const fetchVia = (e: Env, path: string) =>
  router.fetch(new Request(`https://dev.ghfind.com${path}`), e);

describe("non-production crawl policy", () => {
  it("disallows all crawling and hides the sitemap off production", async () => {
    const { env: e, calls } = env("1");
    const robots = await fetchVia(e, "/robots.txt");
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(robots.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect((await fetchVia(e, "/sitemap.xml")).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("forwards robots.txt and sitemap.xml to the API Worker in production", async () => {
    const { env: e, calls } = env("0");
    expect(await (await fetchVia(e, "/robots.txt")).text()).toBe("api");
    expect(await (await fetchVia(e, "/sitemap.xml")).text()).toBe("api");
    expect(calls).toEqual(["api /robots.txt", "api /sitemap.xml"]);
  });
});
