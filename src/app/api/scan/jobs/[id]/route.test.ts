import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("scan job status Go ownership guard", () => {
  it("fails closed instead of exposing internal job state from Next", async () => {
    const response = GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "backend_not_configured" });
  });
});
