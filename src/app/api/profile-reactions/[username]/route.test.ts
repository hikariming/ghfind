import { describe, expect, it } from "vitest";

import { DELETE, GET, PUT } from "./route";

describe("profile reaction route ownership", () => {
  it("does not execute Next persistence when the Go rewrite is absent", async () => {
    for (const handler of [GET, PUT, DELETE]) {
      const response = await handler();
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "backend_not_configured" });
    }
  });
});
