import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/github";
import {
  AIProviderError,
  aiJsonRequest,
  canonicalProviderBaseUrl,
} from "../src/provider-http";

const e: Env = { ...(env as Env), BYOK_REQUIRE_PUBLIC_ENDPOINT: true };
const ENDPOINT = "https://api.vendor.com/v1/chat/completions";
const init = {
  method: "POST",
  headers: { Authorization: "Bearer synthetic-owned-key" },
  body: '{"messages":[]}',
};
const call = (settings = e, deadline = Date.now() + 3000) =>
  aiJsonRequest(settings, ENDPOINT, init, deadline);
type Answer = { name: string; type: number; data: string };
const answer = (
  type: number,
  data: string,
  name = "api.vendor.com.",
): Answer => ({ name, type, data });
function mockDNS(
  resolve: (host: string, type: number) => unknown,
  modelStatus = 200,
) {
  const model = vi.fn(async () =>
    Response.json({ ok: true }, { status: modelStatus }),
  );
  const dns = vi.fn(async (url: URL) =>
    Response.json(
      resolve(
        url.searchParams.get("name")!,
        Number(url.searchParams.get("type")),
      ),
    ),
  );
  const fetcher = vi.fn(
    async (url: RequestInfo | URL, request?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.hostname === "cloudflare-dns.com") {
        expect(parsed.origin + parsed.pathname).toBe(
          "https://cloudflare-dns.com/dns-query",
        );
        expect(new Headers(request?.headers).has("authorization")).toBe(false);
        expect(request?.body).toBeUndefined();
        expect(request?.redirect).toBe("manual");
        return dns(parsed);
      }
      expect(String(url)).toBe(ENDPOINT);
      expect(request?.redirect).toBe("manual");
      expect(new Headers(request?.headers).get("authorization")).toBe(
        "Bearer synthetic-owned-key",
      );
      return model();
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return { dns, model, fetcher };
}
afterEach(() => vi.unstubAllGlobals());

describe("untrusted BYOK endpoint requests", () => {
  it("canonicalizes public HTTPS roots and rejects IP, local, credential and delimiter bypasses without network", () => {
    expect(canonicalProviderBaseUrl(" HTTPS://API.VENDOR.COM:443/v1/// ")).toBe(
      "https://api.vendor.com/v1",
    );
    expect(canonicalProviderBaseUrl("https://api.vendor.com./v1")).toBe(
      "https://api.vendor.com/v1",
    );
    expect(canonicalProviderBaseUrl("https://api.vendor.com:8443/v1")).toBe(
      "https://api.vendor.com:8443/v1",
    );
    for (const value of [
      "http://api.vendor.com/v1",
      "https:api.vendor.com/v1",
      "//api.vendor.com/v1",
      "not-a-url",
      "https://127.0.0.1/v1",
      "https://8.8.8.8/v1",
      "https://2130706433/v1",
      "https://0x7f000001/v1",
      "https://0177.0.0.1/v1",
      "https://[::1]/v1",
      "https://[2606:4700::1111]/v1",
      "https://localhost/v1",
      "https://metadata/v1",
      "https://api.local/v1",
      "https://api.internal/v1",
      "https://api.localhost/v1",
      "https://api.test/v1",
      "https://api.invalid/v1",
      "https://api.corp/v1",
      "https://api.onion/v1",
      "https://api.arpa/v1",
      "https://user:secret@api.vendor.com/v1",
      "https://@api.vendor.com/v1",
      "https://api.vendor.com/v1?key=secret",
      "https://api.vendor.com/v1?",
      "https://api.vendor.com/v1#secret",
      "https://api.vendor.com/v1#",
      "https://api.vendor.com/a\\b",
      "https://api.vendor.com/a\nb",
      "https://api.vendor.com/a\0b",
      "https://api.vendor.com/a b",
      "https://api.vendor.com/" + "x".repeat(2000),
    ])
      expect(() => canonicalProviderBaseUrl(value)).toThrow(
        "AI provider invalid_config",
      );
  });

  it("checks both address families on every request before sending the model key", async () => {
    const mocks = mockDNS((_, type) => ({
      Status: 0,
      Answer: [answer(type, type === 1 ? "8.8.8.8" : "2606:4700::1111")],
    }));
    expect(await call()).toEqual({ ok: true });
    expect(await call()).toEqual({ ok: true });
    expect(mocks.dns).toHaveBeenCalledTimes(4);
    expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(
      mocks.fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname),
    ).toEqual([
      "cloudflare-dns.com",
      "cloudflare-dns.com",
      "api.vendor.com",
      "cloudflare-dns.com",
      "cloudflare-dns.com",
      "api.vendor.com",
    ]);
  });

  it("blocks private/special IPv4, non-public IPv6 and mixed public/private answers before model calls", async () => {
    for (const [type, data] of [
      ...[
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.1",
        "192.0.2.1",
        "192.168.1.1",
        "192.88.99.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "999.1.1.1",
        "01.2.3.4",
      ].map((ip) => [1, ip] as const),
      ...[
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "64:ff9b::a00:1",
        "2001:db8::1",
        "2001:2::1",
        "2002:a00::1",
        "3fff::1",
        "2620:4f:8000::1",
        "2001:::1",
      ].map((ip) => [28, ip] as const),
    ]) {
      const mocks = mockDNS((_, queryType) => ({
        Status: 0,
        Answer:
          queryType === type
            ? [answer(type, data)]
            : [
                answer(
                  queryType,
                  queryType === 1 ? "8.8.8.8" : "2001:4860::8888",
                ),
              ],
      }));
      await expect(call()).rejects.toMatchObject({
        code: "unavailable",
        status: 503,
      });
      expect(mocks.model).not.toHaveBeenCalled();
    }
  });

  it("validates and resolves public CNAME chains and rejects local aliases, private targets and alias cycles", async () => {
    const publicChain = mockDNS((host, type) => ({
      Status: 0,
      Answer:
        host === "api.vendor.com"
          ? [
              answer(5, "edge.vendor.net."),
              ...(type === 1 ? [answer(1, "8.8.8.8", "edge.vendor.net.")] : []),
            ]
          : type === 1
            ? [answer(1, "8.8.8.8", "edge.vendor.net.")]
            : [],
    }));
    expect(await call()).toEqual({ ok: true });
    expect(publicChain.dns).toHaveBeenCalledTimes(4);
    const local = mockDNS(() => ({
      Status: 0,
      Answer: [answer(5, "metadata.internal.")],
    }));
    await expect(call()).rejects.toBeInstanceOf(AIProviderError);
    expect(local.model).not.toHaveBeenCalled();
    const privateTarget = mockDNS((host, type) => ({
      Status: 0,
      Answer:
        host === "api.vendor.com"
          ? [answer(5, "edge.vendor.net.")]
          : type === 1
            ? [answer(1, "10.0.0.1", "edge.vendor.net.")]
            : [],
    }));
    await expect(call()).rejects.toMatchObject({ code: "unavailable" });
    expect(privateTarget.model).not.toHaveBeenCalled();
    const cycle = mockDNS((host) => ({
      Status: 0,
      Answer: [
        answer(
          5,
          host === "api.vendor.com" ? "edge.vendor.net." : "api.vendor.com.",
          `${host}.`,
        ),
      ],
    }));
    await expect(call()).rejects.toMatchObject({ code: "unavailable" });
    expect(cycle.model).not.toHaveBeenCalled();
  });

  it("fails closed for no DNS data, error/truncation, malformed answers and alias bounds", async () => {
    for (const response of [
      { Status: 3 },
      { Status: 2 },
      {},
      { Status: 0 },
      { Status: 0, Answer: [] },
      { Status: 0, TC: true, Answer: [answer(1, "8.8.8.8")] },
      { Status: 0, Answer: "not-an-array" },
      { Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] },
      { Status: 0, Answer: [answer(16, "unexpected")] },
      {
        Status: 0,
        Answer: Array.from({ length: 65 }, () => answer(1, "8.8.8.8")),
      },
    ]) {
      const mocks = mockDNS(() => response);
      await expect(call()).rejects.toMatchObject({ code: "unavailable" });
      expect(mocks.model).not.toHaveBeenCalled();
    }
    const aliases = mockDNS((host) => ({
      Status: 0,
      Answer: [
        answer(
          5,
          `hop${host.startsWith("hop") ? Number(host.match(/^hop(\d+)/)![1]) + 1 : 1}.vendor.net.`,
          `${host}.`,
        ),
      ],
    }));
    await expect(call()).rejects.toMatchObject({ code: "unavailable" });
    expect(aliases.dns).toHaveBeenCalledTimes(16);
    expect(aliases.model).not.toHaveBeenCalled();
  });

  it("bounds DNS response bodies, stalled streams and expired deadlines without sending credentials", async () => {
    const huge = vi.fn(async () => new Response(" ".repeat(33 * 1024)));
    vi.stubGlobal("fetch", huge);
    await expect(call()).rejects.toMatchObject({ code: "unavailable" });
    expect(huge.mock.calls).toHaveLength(2);
    const stalled = vi.fn(
      async () => new Response(new ReadableStream({ start() {} })),
    );
    vi.stubGlobal("fetch", stalled);
    await expect(call(e, Date.now() + 25)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(stalled.mock.calls).toHaveLength(2);
    stalled.mockClear();
    await expect(call(e, Date.now() - 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(stalled).not.toHaveBeenCalled();
  });

  it("never follows DoH/model redirects and preserves provider rate-limit semantics", async () => {
    const redirectedDNS = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://collect.vendor.net" },
        }),
    );
    vi.stubGlobal("fetch", redirectedDNS);
    await expect(call()).rejects.toMatchObject({ code: "unavailable" });
    expect(redirectedDNS.mock.calls).toHaveLength(2);
    const mocks = mockDNS(
      (_, type) => ({
        Status: 0,
        Answer: type === 1 ? [answer(1, "8.8.8.8")] : [],
      }),
      307,
    );
    await expect(call()).rejects.toMatchObject({ status: 307 });
    expect(mocks.model).toHaveBeenCalledTimes(1);
    const quota = mockDNS(
      (_, type) => ({
        Status: 0,
        Answer: type === 1 ? [answer(1, "8.8.8.8")] : [],
      }),
      429,
    );
    await expect(call()).rejects.toMatchObject({
      status: 429,
      quota: false,
      retry: true,
    });
    expect(quota.model).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 429 })),
    );
    await expect(call()).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });

  it("does not change trusted platform requests or swallow their HTTP failures", async () => {
    const fetcher = vi.fn(async () => Response.json({ platform: true }));
    vi.stubGlobal("fetch", fetcher);
    expect(await call({ ...e, BYOK_REQUIRE_PUBLIC_ENDPOINT: false })).toEqual({
      platform: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      ENDPOINT,
      expect.objectContaining({ redirect: "manual" }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(
      call({ ...e, BYOK_REQUIRE_PUBLIC_ENDPOINT: false }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
