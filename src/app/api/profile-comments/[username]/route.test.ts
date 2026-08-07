import { describe, expect, it } from "vitest";

import { GET, POST } from "./route";

describe("profile comment route ownership", () => {
  it("does not execute Next persistence when the Go rewrite is absent", async () => {
    for (const handler of [GET, POST]) {
      const response = await handler();
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "backend_not_configured" });
    }
  });
});
