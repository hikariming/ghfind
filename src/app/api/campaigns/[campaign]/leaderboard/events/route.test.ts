import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("campaign leaderboard SSE Go ownership guard", () => {
  it("does not retain Next Redis polling or EventSource state", async () => {
    const response = GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "backend_not_configured" });
  });
});
