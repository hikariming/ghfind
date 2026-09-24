import { describe, expect, it } from "vitest";
import { NAV_GROUPS, NAV_ITEMS } from "@/config/nav";
import en from "@/messages/en.json";

describe("primary navigation", () => {
  it("leads with the core actions, then flat intent-based groups", () => {
    expect(NAV_GROUPS.map(group => group.label)).toEqual([undefined, "groupDiscover", "groupCareer", "groupTools"]);
    expect(NAV_GROUPS[0].items.map(item => item.href)).toEqual(["/", "/vs"]);
    expect(NAV_GROUPS[0].items[0].featured).toBe(true);
    expect(NAV_GROUPS[1].items.map(item => item.href)).toEqual(["/leaderboard", "/projects", "/collections", "/blog"]);
    expect(NAV_GROUPS[2].items.map(item => item.href)).toEqual(["/resume", "/talent"]);
    expect(NAV_GROUPS[3].items.map(item => item.href)).toEqual(["/github-bot"]);
    expect(NAV_ITEMS.every(item => !item.children)).toBe(true);
  });

  it("has a label and hover hint for every item and group", () => {
    const nav = en.nav as Record<string, unknown> & { hint: Record<string, string> };
    for (const item of NAV_ITEMS) {
      expect(nav[item.key], `nav.${item.key}`).toBeTypeOf("string");
      expect(nav.hint[item.key], `nav.hint.${item.key}`).toBeTypeOf("string");
    }
    for (const group of NAV_GROUPS) if (group.label) expect(nav[group.label]).toBeTypeOf("string");
  });
});
