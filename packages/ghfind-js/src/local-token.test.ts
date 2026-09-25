import { afterEach, describe, expect, it, vi } from "vitest";
import { collectAndScore } from "./local";
import { collect, ghFetch, githubTokens } from "../../../src/lib/github";

vi.mock("../../../src/lib/github", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/lib/github")>(),
  collect: vi.fn(),
}));
vi.mock("../../../src/lib/score", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/lib/score")>(),
  score: vi.fn(() => ({ final_score: 0 })),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function requestToken() {
  const response = await ghFetch("https://api.github.com/users/fixture");
  return response.text();
}
function mockTransport() {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) =>
    new Response(new Headers(init.headers).get("authorization"))));
}
const data = { metrics: {} } as Awaited<ReturnType<typeof collect>>;

describe("local SDK credential isolation", () => {
  it.each([false, true])("preserves defaults after collection (failure=%s)", async (fail) => {
    vi.stubEnv("GITHUB_TOKEN", "default-token");
    mockTransport();
    vi.mocked(collect).mockImplementation(async () => {
      expect(await requestToken()).toBe("Bearer override-token");
      if (fail) throw new Error("fixture failure");
      return data;
    });
    const call = collectAndScore("fixture", { token: "override-token" });
    if (fail) await expect(call).rejects.toThrow("fixture failure");
    else await call;
    expect(process.env.GITHUB_TOKEN).toBe("default-token");
    expect(githubTokens()).toEqual(["default-token"]);
    vi.mocked(collect).mockImplementation(async () => {
      expect(await requestToken()).toBe("Bearer default-token");
      return data;
    });
    await collectAndScore("fixture");
  });

  it("does not create an environment token when none was configured", async () => {
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.mocked(collect).mockResolvedValue(data);
    await collectAndScore("fixture", { token: "override-token" });
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    await expect(collectAndScore("fixture")).rejects.toThrow("needs a GitHub token");
  });

  it("keeps interleaved collections and the ambient token separate", async () => {
    vi.stubEnv("GITHUB_TOKEN", "default-token");
    mockTransport();
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(collect).mockImplementation(async (username) => {
      expect(await requestToken()).toBe(`Bearer ${username}-token`);
      if (++arrivals === 2) release();
      await barrier;
      expect(await requestToken()).toBe(`Bearer ${username}-token`);
      return data;
    });
    const calls = [
      collectAndScore("first", { token: "first-token" }),
      collectAndScore("second", { token: "second-token" }),
    ];
    expect(await requestToken()).toBe("Bearer default-token");
    await Promise.all(calls);
  });
});
