import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("facet-rank Go ownership guard", () => {
  it("never falls back to a Next handler with direct Turso or Redis access", async () => {
    const response = GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "backend_not_configured" });
  });
});
