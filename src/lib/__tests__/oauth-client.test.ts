import { afterEach, describe, expect, it, vi } from "vitest";
import { signInWithProvider, signOut } from "@/lib/oauth-client";

afterEach(() => vi.unstubAllGlobals());

function mockLocation() {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { origin: "https://ghfind.com", href: "https://ghfind.com/en?auth_error=google_failed&username=octocat", assign } });
  return assign;
}

describe("provider navigation", () => {
  it("retains the return page and removes a consumed callback error", () => {
    const assign = mockLocation();
    signInWithProvider("google");
    const destination = new URL(assign.mock.calls[0][0], "https://ghfind.com");
    expect(destination.pathname).toBe("/api/auth/google");
    expect(destination.searchParams.get("callbackUrl")).toBe("https://ghfind.com/en?username=octocat");
  });

  it("does not navigate away when the server failed to clear the session", async () => {
    const assign = mockLocation();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    expect(await signOut()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("keeps a failed network sign-out visible to its caller", async () => {
    const assign = mockLocation();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await signOut()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("returns home only after the server accepts sign-out", async () => {
    const assign = mockLocation();
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    expect(await signOut()).toBe(true);
    expect(assign).toHaveBeenCalledWith("/");
    expect(fetch).toHaveBeenCalledWith("/api/auth/signout", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
  });
});
