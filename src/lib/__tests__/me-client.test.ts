import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("runtime sign-in options", () => {
  it("only offers explicitly configured social providers and preserves legacy GitHub", async () => {
    const { loginProviders } = await import("@/lib/me-client");
    expect(loginProviders({ user: null, scored: false })).toEqual({ github: true, google: false, apple: false });
    expect(loginProviders({ user: null, scored: false, oauth: true, providers: { github: false, google: true, apple: false } })).toEqual({ github: false, google: true, apple: false });
  });

  it("deduplicates probes and keeps a Google identity separate from GitHub capabilities", async () => {
    const response = { user: null, account: { provider: "google", subject: "123", name: "Test User", image: null }, scored: false, oauth: true, providers: { github: true, google: true, apple: false } };
    const fetch = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetch);
    const { fetchMe } = await import("@/lib/me-client");
    const [first, second] = await Promise.all([fetchMe(), fetchMe()]);
    expect(first).toEqual(response);
    expect(second.user).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });

  it.each([new Response("unavailable", { status: 503 }), Response.json({ error: "unavailable" }), new Response("not json")])("shows a retryable failure instead of pretending login is configured", async (response) => {
    const fetch = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(Response.json({ user: null, scored: false, providers: { github: true, google: true, apple: false } }));
    vi.stubGlobal("fetch", fetch);
    const { fetchMe, loginProviders } = await import("@/lib/me-client");
    const unavailable = await fetchMe();
    expect(unavailable.loadFailed).toBe(true);
    expect(loginProviders(unavailable)).toEqual({ github: false, google: false, apple: false });
    expect((await fetchMe()).providers?.google).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("can refresh a valid but temporarily unconfigured deployment", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ user: null, scored: false, oauth: false })).mockResolvedValueOnce(Response.json({ user: null, scored: false, oauth: true }));
    vi.stubGlobal("fetch", fetch);
    const { fetchMe } = await import("@/lib/me-client");
    expect((await fetchMe()).oauth).toBe(false);
    expect((await fetchMe({ refresh: true })).oauth).toBe(true);
  });
});
