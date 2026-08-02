import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeRoastingHandoff } from "../home-handoff";

afterEach(() => {
  vi.unstubAllGlobals();
});

function installHistory(href: string, initialState: unknown = null) {
  let state = initialState;
  const location = { href };
  const history = {
    get state() {
      return state;
    },
    replaceState(nextState: unknown, _unused: string, nextUrl: URL) {
      state = nextState;
      location.href = nextUrl.toString();
    },
  };

  vi.stubGlobal("window", { location, history });
  return { location, history };
}

describe("consumeRoastingHandoff", () => {
  it("spends a handoff once while preserving other query parameters and history state", () => {
    const { location, history } = installHistory(
      "https://ghfind.com/u/octo?roasting=1&campaign=advx",
      { __NA: true },
    );

    expect(consumeRoastingHandoff()).toBe(true);
    expect(location.href).toBe("https://ghfind.com/u/octo?campaign=advx");
    expect(history.state).toMatchObject({
      __NA: true,
      __ghfindRoastingHandoffConsumed: true,
    });
    expect(consumeRoastingHandoff()).toBe(false);
  });

  it("does not consume an ordinary profile visit", () => {
    installHistory("https://ghfind.com/u/octo?campaign=advx");

    expect(consumeRoastingHandoff()).toBe(false);
  });
});
