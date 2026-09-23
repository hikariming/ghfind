import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/config/nav";

describe("primary navigation", () => {
  it("groups interaction and content while keeping boards directly accessible", () => {
    expect(NAV_ITEMS.map(item => item.key)).toEqual(["interaction", "leaderboard", "projectBoards", "content"]);
    expect(NAV_ITEMS[0].children?.map(item => item.href)).toEqual(["/", "/vs"]);
    expect(NAV_ITEMS[1].href).toBe("/leaderboard");
    expect(NAV_ITEMS[2].href).toBe("/projects");
    expect(NAV_ITEMS[3].children?.map(item => item.href)).toEqual(["/collections", "/blog"]);
  });
});
