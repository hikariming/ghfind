import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn<(request: Request) => Promise<Response>>() }));
vi.mock("cloudflare:workers", () => ({ env: { API: api } }));

const request = (cookie?: string) =>
  new Request("https://ghfind.com/u/octocat", cookie ? { headers: { cookie } } : undefined);
const me = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(() => {
  vi.resetModules();
  api.fetch.mockReset();
});

describe("getViewer", () => {
  it("asks the API once per isolate for anonymous visitors", async () => {
    const { getViewer } = await import("../session");
    api.fetch.mockResolvedValue(me({ user: null, oauth: true }));
    expect(await getViewer(request())).toEqual({ login: null, oauth: true });
    expect(await getViewer(request("theme=dark"))).toEqual({ login: null, oauth: true });
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not memoize a failed probe", async () => {
    const { getViewer } = await import("../session");
    api.fetch.mockRejectedValueOnce(new Error("down")).mockResolvedValue(me({ user: null, oauth: true }));
    expect(await getViewer(request())).toEqual({ login: null, oauth: false });
    expect(await getViewer(request())).toEqual({ login: null, oauth: true });
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it("always asks the API when a session cookie is present", async () => {
    const { getViewer } = await import("../session");
    api.fetch.mockImplementation(async () => me({ user: { login: "octocat" }, oauth: true }));
    await getViewer(request());
    expect(await getViewer(request("ghfind_session=abc"))).toEqual({ login: "octocat", oauth: true });
    expect(await getViewer(request("ghfind_session=abc"))).toEqual({ login: "octocat", oauth: true });
    expect(api.fetch).toHaveBeenCalledTimes(3);
    expect(api.fetch.mock.calls[1][0].headers.get("cookie")).toBe("ghfind_session=abc");
  });
});
