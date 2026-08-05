import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("score route ownership", () => {
  it("does not execute the Node collector when the Go rewrite is absent", async () => {
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "backend_not_configured" });
  });
});
