import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyTurnstile: vi.fn(),
  goBackendOrigin: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }));
vi.mock("@/lib/go-backend.server", () => ({ goBackendOrigin: mocks.goBackendOrigin }));

import { POST } from "./route";

describe("vs verdict human-check gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GHFIND_VERDICT_GATEWAY_SECRET = "gateway-secret";
    mocks.goBackendOrigin.mockReturnValue("https://api.example.test");
    mocks.verifyTurnstile.mockResolvedValue(true);
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("fails closed when either gateway setting is absent", async () => {
    mocks.goBackendOrigin.mockReturnValue(null);
    const response = await POST(
      new NextRequest("https://example.test/api/vs-verdict", {
        method: "POST",
        body: JSON.stringify({ a: "alice", b: "bob" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.verifyTurnstile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects a failed human-check before forwarding", async () => {
    mocks.verifyTurnstile.mockResolvedValue(false);
    const response = await POST(
      new NextRequest("https://example.test/api/vs-verdict", {
        method: "POST",
        body: JSON.stringify({ a: "alice", b: "bob" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("passes the client token and IP to the Turnstile verification", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await POST(
      new NextRequest("https://example.test/api/vs-verdict", {
        method: "POST",
        headers: {
          "x-turnstile-token": "tok-123",
          "cf-connecting-ip": "198.51.100.42",
        },
        body: JSON.stringify({ a: "alice", b: "bob" }),
      }),
    );

    expect(mocks.verifyTurnstile).toHaveBeenCalledWith("tok-123", "198.51.100.42");
  });

  it("forwards only an approved body with an HMAC-bound client identity", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ verdict: null, reason: "below_floor" }), {
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      }),
    );
    const body = JSON.stringify({ a: "alice", b: "bob" });
    const response = await POST(
      new NextRequest("https://example.test/api/vs-verdict", {
        method: "POST",
        headers: { "x-vercel-forwarded-for": "198.51.100.42, 203.0.113.9" },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [target, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(target).toBe("https://api.example.test/api/internal/vs-verdict");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    const headers = init.headers as Record<string, string>;
    const timestamp = headers["X-Ghfind-Gateway-Timestamp"];
    expect(headers["X-Ghfind-Client-IP"]).toBe("198.51.100.42");
    expect(headers["X-Ghfind-Gateway-Signature"]).toBe(
      createHmac("sha256", "gateway-secret")
        .update(`${timestamp}\n198.51.100.42\n${body}`, "utf8")
        .digest("hex"),
    );
  });

  it("prefers the Cloudflare client IP over the Vercel header", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await POST(
      new NextRequest("https://example.test/api/vs-verdict", {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "x-vercel-forwarded-for": "198.51.100.42",
        },
        body: JSON.stringify({ a: "alice", b: "bob" }),
      }),
    );

    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Ghfind-Client-IP"]).toBe("203.0.113.7");
  });

  it("does not trust caller-supplied generic X-Forwarded-For", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    const body = JSON.stringify({ a: "alice", b: "bob" });
    await POST(
      new NextRequest("https://example.test/api/vs-verdict", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.42" },
        body,
      }),
    );

    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Ghfind-Client-IP"]).toBe("unknown");
  });
});
