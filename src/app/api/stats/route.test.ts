import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("stats Go ownership guard", () => {
  it("never falls back to a Next handler with direct data access", async () => {
    const response = GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "backend_not_configured",
      message: "The Go API origin is not configured for this deployment.",
    });
  });
});
