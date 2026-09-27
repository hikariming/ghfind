import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /cli", () => {
  it("redirects the readable localized path to the hosted CLI reference", () => {
    const response = GET(new NextRequest("https://dev.ghfind.test/zh/cli"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://dev.ghfind.test/cli.md");
  });
});
