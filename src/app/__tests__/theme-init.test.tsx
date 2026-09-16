import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RootLayout from "../layout";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "geist-sans" }),
  Geist_Mono: () => ({ variable: "geist-mono" }),
}));
vi.mock("@/components/AnalyticsGate", () => ({ default: () => null }));
vi.mock("next/script", () => ({ default: () => null }));

// Only native head scripts survive the next/script mock. Running the emitted
// script without a Next.js runtime catches deferring theme setup to bootstrap.
function initialize({
  stored = null,
  systemLight = true,
  storageFailure,
  path = "/en/about",
}: {
  stored?: string | null;
  systemLight?: boolean;
  storageFailure?: "read" | "write";
  path?: string;
} = {}) {
  const markup = renderToStaticMarkup(<RootLayout><main>Page</main></RootLayout>);
  const head = markup.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
  const script = head.match(/<script id="theme-init">([\s\S]*?)<\/script>/)?.[1];
  expect(script, "theme initialization must run directly in the head").toBeTruthy();
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string>, lang: "", dir: "" };
  const url = new URL(path, "https://ghfind.com");
  const storage = {
    getItem: () => {
      if (storageFailure === "read") throw new Error("Storage unavailable");
      return stored;
    },
    setItem: vi.fn(() => {
      if (storageFailure === "write") throw new Error("Storage unavailable");
    }),
  };
  runInNewContext(script!, {
    document: { documentElement: root },
    window: { location: url, matchMedia: () => ({ matches: systemLight }) },
    localStorage: storage,
    URLSearchParams,
  });
  return { root, storage };
}

describe("theme initialization before client bootstrap", () => {
  it.each([
    ["light", false, "light", "light"],
    ["dark", true, "dark", "dark"],
    ["auto", true, "auto", "light"],
    ["auto", false, "auto", "dark"],
    [null, true, "auto", "light"],
    [null, false, "auto", "dark"],
    ["invalid", true, "auto", "light"],
  ])("resolves saved %s with system light=%s", (stored, systemLight, mode, theme) => {
    const { root } = initialize({ stored, systemLight });
    expect(root.dataset).toEqual({ themeMode: mode, theme });
    expect(root.style.colorScheme).toBe(theme);
  });

  it.each([true, false])("uses the system theme when storage reads fail (light=%s)", (systemLight) => {
    const { root } = initialize({ storageFailure: "read", systemLight });
    expect(root.dataset).toEqual({ themeMode: "auto", theme: systemLight ? "light" : "dark" });
  });

  it.each(["/advx", "/en/advx", "/en/about?campaign=advx"])("preserves the campaign override at %s even if saving fails", (path) => {
    const { root, storage } = initialize({ stored: "light", storageFailure: "write", path });
    expect(root.dataset).toEqual({ themeMode: "dark", theme: "dark" });
    expect(storage.setItem).toHaveBeenCalledWith("github-roast-theme", "dark");
  });

  it("preserves initial locale and direction", () => {
    const { root } = initialize({ path: "/ar/about" });
    expect(root.lang).toBe("ar");
    expect(root.dir).toBe("rtl");
  });
});
