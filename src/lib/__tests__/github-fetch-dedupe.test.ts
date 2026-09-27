import { afterEach, expect, it, vi } from "vitest";
import { createDedupeFetch } from "next/dist/server/lib/dedupe-fetch";
import type { TopRepo } from "../types";
import { ghFetch, hydrateTopRepoEvidence } from "../github";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([404, 502])("releases HTTP %s bodies with the actual Next deduplicating fetch", async status => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const cancel = vi.fn();
  const upstream = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { status }));
  vi.stubGlobal("fetch", createDedupeFetch(upstream));
  const response = await ghFetch("https://api.github.com/repos/org/repo/readme", {}, { splitOnTimeout: true });
  expect(response.status).toBe(status);
  expect(cancel).toHaveBeenCalledOnce();
  expect(upstream).toHaveBeenCalledOnce();
  expect(upstream.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
}, 1000);

it("preserves a caller's abort signal", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const controller = new AbortController();
  const upstream = vi.fn<typeof fetch>(async () => new Response("{}"));
  vi.stubGlobal("fetch", createDedupeFetch(upstream));
  await ghFetch("https://api.github.com/users/example", { signal: controller.signal });
  expect(upstream.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
});


it("releases a truncated raw README body through Next fetch", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const cancel = vi.fn();
  const upstream = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/readme")) return Response.json({
      size: 2 * 1024 * 1024, download_url: "https://raw.githubusercontent.com/org/repo/main/README.md",
    });
    if (url.endsWith("/languages")) return Response.json({ TypeScript: 100 });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1).fill(65)); },
      cancel,
    }));
  });
  vi.stubGlobal("fetch", createDedupeFetch(upstream));
  const result = await hydrateTopRepoEvidence([{ name: "repo", owner_login: "org" } as TopRepo], "org");
  expect(cancel).toHaveBeenCalledOnce();
  expect(result[0].readme?.truncated).toBe(true);
  expect(result[0].languages).toEqual([{ name: "TypeScript", size: 100 }]);
}, 1000);
