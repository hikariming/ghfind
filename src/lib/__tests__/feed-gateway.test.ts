import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEED_BODY_LIMIT, forwardFeedRequest, readBoundedBody, signFeedGateway } from "../feed-gateway";

const platform = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: platform.env }) }));

const secret = "gateway-test-only-secret-with-at-least-32-bytes";
const viewer = { githubId: 123, login: "example", image: null };

afterEach(() => { platform.env = {}; vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function enable() {
  vi.stubEnv("FEED_BACKEND", "go");
  vi.stubEnv("FEED_GATEWAY_SECRET", secret);
  vi.stubEnv("FEED_API_ORIGIN", "https://feed.example.test");
}

function rollout(mode = "internal", points = "0") {
  enable();
  vi.stubEnv("FEED_ROLLOUT_MODE", mode);
  vi.stubEnv("FEED_ROLLOUT_GITHUB_IDS", String(viewer.githubId));
  vi.stubEnv("FEED_ROLLOUT_SEED", "fixture-stable-seed-v1");
  vi.stubEnv("FEED_ROLLOUT_BASIS_POINTS", points);
}

describe("Feed gateway boundary", () => {
  it("keeps legacy enabled by default without reading the body or making a call", async () => {
    vi.stubEnv("FEED_BACKEND", "legacy");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const request = new Request("https://ghfind.test/api/feed/events", { method: "POST", body: "{}" });
    expect(await forwardFeedRequest(request, viewer)).toBeNull();
    expect(request.bodyUsed).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("signs exact actor, method, escaped target and body with a short dedicated context", () => {
    const token = signFeedGateway({ viewer, method: "post", target: "/api/feed/events?x=%2F", body: new TextEncoder().encode("{}"), secret, now: 1788825600000 });
    const [payload, signature] = token.split(".");
    expect(signature).toBe(createHmac("sha256", secret).update(`feed-gateway-v1\n${payload}`).digest("base64url"));
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      version: 1, audience: "feed-api", githubId: 123, login: "example", avatarUrl: "",
      issuedAt: 1788825600000, expiresAt: 1788825630000, method: "POST", target: "/api/feed/events?x=%2F",
      bodySha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    });
  });

  it("strips forged identity, cookie, admin and network headers and filters response headers", async () => {
    enable();
    const fetcher = vi.fn(async () => new Response('{"accepted":1}', { status: 202, headers: {
      "content-type": "application/json", "set-cookie": "bad=1", "x-feed-internal": "private", "retry-after": "2",
    } }));
    vi.stubGlobal("fetch", fetcher);
    const response = await forwardFeedRequest(new Request("https://ghfind.test/api/feed/events?x=%2F", {
      method: "POST", body: "{}", headers: { "content-type": "application/json", "X-Feed-Gateway": "forged", "x-github-id": "999", Cookie: "oauth=secret", Authorization: "Bearer admin", "x-forwarded-for": "127.0.0.1" },
    }), viewer);
    expect(response?.status).toBe(202);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("set-cookie")).toBeNull();
    expect(response?.headers.get("x-feed-internal")).toBeNull();
    expect(response?.headers.get("retry-after")).toBe("2");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://feed.example.test/api/feed/events?x=%2F");
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(["accept", "cache-control", "content-type", "x-feed-gateway"]);
    expect(headers.get("x-feed-gateway")).not.toBe("forged");
    expect(init.redirect).toBe("error");
  });

  it("matches the Go verifier's fixed cross-language fixture", () => {
    const token = signFeedGateway({
      viewer: { githubId: 42, login: "octocat", image: "https://avatars.githubusercontent.com/u/42" },
      method: "PUT", target: "/api/feed/projects/octo/repo/state?mode=test",
      body: new TextEncoder().encode('{"saved":true,"impressionToken":"fixture"}'),
      secret: "fixture-gateway-secret-0123456789abcdef", now: 1788825600000,
    });
    expect(token.split(".")[1]).toBe("jGCAotv6ohscgkhltuUn3vOUo1f1AQHLyuU1i_pmQ-I");
  });

  it("uses the service binding with signed identity and no client credentials", async () => {
    enable();
    const external = vi.fn(); vi.stubGlobal("fetch", external);
    const service = { fetch: vi.fn(async function (this: unknown, _url: string, init?: RequestInit) {
      expect(this).toBe(service);
      const headers = new Headers(init?.headers);
      expect([...headers.keys()].sort()).toEqual(["accept", "cache-control", "x-feed-gateway"]);
      const claims = JSON.parse(Buffer.from(headers.get("x-feed-gateway")!.split(".")[0], "base64url").toString());
      expect(claims.githubId).toBe(viewer.githubId);
      expect(claims.target).toBe("/api/feed/projects?cursor=a%2Fb");
      return new Response('{"projects":[]}', { headers: { "content-type": "application/json" } });
    }) };
    platform.env.FEED_RUNTIME = service;
    const response = await forwardFeedRequest(new Request("https://ghfind.test/api/feed/projects?cursor=a%2Fb", {
      headers: { Cookie: "secret=1", "X-Feed-Gateway": "forged", "x-github-id": "999" },
    }), viewer);
    expect(response?.status).toBe(200);
    expect(service.fetch).toHaveBeenCalledOnce();
    expect(external).not.toHaveBeenCalled();
  });

  it("admits the internal OAuth viewer and returns route proof only to that account", async () => {
    rollout();
    const external = vi.fn(); vi.stubGlobal("fetch", external);
    const service = { fetch: vi.fn(async () => new Response('{"items":[]}', { headers: { "content-type": "application/json", "x-feed-gateway-backend": "forged-upstream", "x-feed-runtime-sha": "unverified" } })) };
    platform.env.FEED_RUNTIME = service;
    const response = await forwardFeedRequest(new Request("https://ghfind.test/api/feed/projects"), viewer);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-feed-gateway-backend")).toBe("go");
    expect(response?.headers.get("x-feed-gateway-rollout")).toBe("internal");
    expect(response?.headers.get("x-feed-runtime-sha")).toBeNull();
    expect(service.fetch).toHaveBeenCalledOnce();
    expect(external).not.toHaveBeenCalled();

    rollout("all", "10000");
    const other = await forwardFeedRequest(new Request("https://ghfind.test/api/feed/projects"), { ...viewer, githubId: 456 });
    expect(other?.status).toBe(200);
    expect(other?.headers.get("x-feed-gateway-backend")).toBeNull();
    expect(other?.headers.get("x-feed-gateway-rollout")).toBeNull();
  });

  it.each(["internal", "paused"])("does not read a rejected user's body, trust client overrides or invoke either writer in %s mode", async mode => {
    rollout(mode);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const service = { fetch: vi.fn() }; platform.env.FEED_RUNTIME = service;
    const request = new Request("https://ghfind.test/api/feed/events?backend=go&githubId=123&rollout=all", {
      method: "POST", body: "{}", headers: { "x-github-id": "123", "x-feed-gateway": "forged", "x-feed-backend": "go", "x-feed-rollout": "all" },
    });
    const response = await forwardFeedRequest(request, { ...viewer, githubId: 456 });
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(request.bodyUsed).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(service.fetch).not.toHaveBeenCalled();
  });

  it("never falls back after a selected Go mutation fails", async () => {
    rollout();
    const external = vi.fn(); vi.stubGlobal("fetch", external);
    const service = { fetch: vi.fn(async () => { throw new Error("connection lost after upstream commit"); }) };
    platform.env.FEED_RUNTIME = service;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = new Request("https://ghfind.test/api/feed/preferences", { method: "PUT", body: "{}" });
    expect((await forwardFeedRequest(request, viewer))?.status).toBe(503);
    expect(request.bodyUsed).toBe(true);
    expect(service.fetch).toHaveBeenCalledOnce();
    expect(external).not.toHaveBeenCalled();
  });

  it("rejects a backend-only rollback while writer-v2 rollout configuration remains", async () => {
    rollout();
    vi.stubEnv("FEED_BACKEND", "legacy");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const request = new Request("https://ghfind.test/api/feed/profile", { method: "DELETE" });
    expect((await forwardFeedRequest(request, viewer))?.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, {}, { fetch: "invalid" }, { fetch: async () => { throw new Error("service unavailable"); } }])(
    "does not escape to the network when a configured service binding fails",
    async (binding) => {
      enable();
      platform.env.FEED_RUNTIME = binding;
      const external = vi.fn(); vi.stubGlobal("fetch", external);
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await forwardFeedRequest(new Request("https://ghfind.test/api/feed/projects"), viewer))?.status).toBe(503);
      expect(external).not.toHaveBeenCalled();
    },
  );

  it("bounds chunked bodies even without Content-Length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(FEED_BODY_LIMIT)); controller.enqueue(new Uint8Array(1)); },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedBody(body, FEED_BODY_LIMIT)).rejects.toThrow("exceeds");
    expect(cancelled).toBe(true);
  });

  it.each(["unexpected", ""]) ("fails closed for invalid backend %s", async (backend) => {
    vi.stubEnv("FEED_BACKEND", backend);
    const response = await forwardFeedRequest(new Request("https://ghfind.test/api/feed/projects"), viewer);
    expect(response?.status).toBe(503);
  });

  it("bounds stalled streams even when peer cancellation never completes", async () => {
    for (const oversized of [false, true]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { if (oversized) controller.enqueue(new Uint8Array(FEED_BODY_LIMIT + 1)); },
        cancel() { cancelled = true; return new Promise<void>(() => {}); },
      });
      const started = Date.now();
      await expect(readBoundedBody(body, FEED_BODY_LIMIT, 20)).rejects.toThrow(oversized ? "exceeds" : "timed out");
      expect(cancelled).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it("rejects shared OAuth signing secrets and non-origin upstream configuration", async () => {
    enable();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("AUTH_SECRET", secret);
    expect((await forwardFeedRequest(new Request("https://ghfind.test/api/feed/projects"), viewer))?.status).toBe(503);
    vi.stubEnv("AUTH_SECRET", "different");
    vi.stubEnv("FEED_API_ORIGIN", "https://feed.example.test/prefix");
    expect((await forwardFeedRequest(new Request("https://ghfind.test/api/feed/projects"), viewer))?.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
