import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/github", () => ({ ghFetch: mocks.fetch }));
vi.mock("@/lib/redis", () => ({ getCachedGitHubX: mocks.get, setCachedGitHubX: mocks.set }));
import { githubProfileXUrl } from "./github-profile";
beforeEach(() => { vi.resetAllMocks(); });
describe("GitHub-declared X profile link", () => {
  it("resolves by stable ID and caches a valid declaration", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ id: 44112348, twitter_username: "keking99" }));
    expect(await githubProfileXUrl("44112348")).toBe("https://x.com/keking99");
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://api.github.com/user/44112348");
    expect(mocks.set).toHaveBeenCalledWith("44112348", "https://x.com/keking99");
  });
  it("uses cached absence without repeated GitHub calls", async () => {
    mocks.get.mockResolvedValue(null);
    expect(await githubProfileXUrl("7")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects mismatched IDs, malformed handles and transient failures", async () => {
    for (const profile of [{ id: 8, twitter_username: "valid" }, { id: 7, twitter_username: "bad/path" }, { id: 7 }]) {
      mocks.fetch.mockResolvedValue(Response.json(profile));
      expect(await githubProfileXUrl("7")).toBeNull();
    }
    mocks.fetch.mockRejectedValue(new Error("timeout"));
    expect(await githubProfileXUrl("7")).toBeNull();
  });
});
