import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/config/nav";

describe("primary navigation", () => {
  it("keeps Roast first and groups developer discovery", () => {
    expect(NAV_ITEMS[0]).toMatchObject({ key: "roast", href: "/" });
    const discover = NAV_ITEMS.find((item) => item.key === "discover");
    expect(discover?.children).toEqual([
      { key: "developers", href: "/developers" },
      { key: "projectBoards", href: "/projects" },
      { key: "collections", href: "/collections" },
      { key: "languages", href: "/developers#languages", exact: true },
      { key: "organizations", href: "/developers#organizations", exact: true },
    ]);
    expect(NAV_ITEMS.at(-1)).toEqual({ key: "blog", href: "/blog" });
  });
});
