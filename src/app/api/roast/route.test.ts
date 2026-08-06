import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POST /api/roast fallback ownership", () => {
  it("fails closed instead of resurrecting a Next-owned LLM path", async () => {
    const response = POST();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: "backend_not_configured" });
  });
});
