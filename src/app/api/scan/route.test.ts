import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("scan Go ownership guard", () => {
  it("never falls back to Next for collection, scoring, or persistence", async () => {
    const response = POST();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "backend_not_configured" });
  });
});
