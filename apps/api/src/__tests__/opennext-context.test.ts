import { describe, expect, it, vi } from "vitest";
import { requestContext } from "../request-context";

vi.mock("cloudflare:workers", () => ({ env: { GHFIND_D1: "fixture" } }));
import { getCloudflareContext } from "../shims/opennext-cloudflare";

describe("Cloudflare request context shim", () => {
  it("keeps bindings accessible without a request", () => {
    expect(getCloudflareContext().env).toEqual({ GHFIND_D1: "fixture" });
    expect(getCloudflareContext().ctx).toBeUndefined();
  });
  it("exposes the current request's background task lifetime", async () => {
    const pending: Promise<unknown>[] = [];
    const task = Promise.resolve("refreshed");
    requestContext.run({ request: new Request("https://ghfind.test/api/leaderboard"), waitUntil: promise => pending.push(promise) }, () => {
      getCloudflareContext().ctx!.waitUntil(task);
    });
    expect(pending).toEqual([task]);
    await expect(Promise.all(pending)).resolves.toEqual(["refreshed"]);
    expect(getCloudflareContext().ctx).toBeUndefined();
  });
});
