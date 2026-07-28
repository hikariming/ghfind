import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/config/nav";

describe("primary navigation", () => {
  it("keeps Roast first, groups developer discovery, and puts Projects last", () => {
    expect(NAV_ITEMS[0]).toMatchObject({ key: "roast", href: "/" });
    const discover = NAV_ITEMS.find((item) => item.key === "discover");
    expect(discover?.children).toEqual([
      { key: "developers", href: "/developers" },
      { key: "languages", href: "/developers#languages", exact: true },
      { key: "organizations", href: "/developers#organizations", exact: true },
    ]);
    expect(NAV_ITEMS.at(-1)).toEqual({ key: "projects", href: "/projects" });
  });
});
