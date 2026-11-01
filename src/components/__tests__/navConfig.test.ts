import { describe, expect, it } from "vitest";
import { NAV_GROUPS, NAV_ITEMS, isExternalNavItem } from "@/config/nav";
import en from "@/messages/en.json";
import zh from "@/messages/zh.json";

describe("primary navigation", () => {
  it("leads with the core actions, then flat intent-based groups", () => {
    expect(NAV_GROUPS.map(group => group.label)).toEqual([undefined, "groupDiscover", "groupCareer", "groupTools"]);
    expect(NAV_GROUPS[0].items.map(item => item.href)).toEqual(["/", "https://missionhub-oss.github.io/mfcp/"]);
    expect(NAV_GROUPS[0].items[0].featured).toBe(true);
    expect(NAV_GROUPS[1].items.map(item => item.href)).toEqual(["/feed", "/discover", "/talent", "/leaderboard", "/projects", "/collections"]);
    expect(NAV_GROUPS[2].items.map(item => item.href)).toEqual(["/talent-match", "/jobs", "/resume"]);
    expect(NAV_GROUPS[3].items.map(item => item.href)).toEqual(["/github-bot", "/integrations"]);
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

  it("links the MFCP event out to its site instead of the in-app Developer PK", () => {
    const mfcp = NAV_ITEMS.find(item => item.key === "mfcp");
    expect(mfcp?.href).toBe("https://missionhub-oss.github.io/mfcp/");
    expect(mfcp?.external).toBe(true);
    expect(mfcp?.event).toBe(true);
    expect(mfcp && isExternalNavItem(mfcp)).toBe(true);
    expect(NAV_ITEMS.some(item => item.key === "versus" || item.href === "/vs")).toBe(false);
    expect(NAV_ITEMS.filter(isExternalNavItem).map(item => item.key)).toEqual(["mfcp"]);
    expect(zh.nav.mfcp).toBe("MFCP 开源培养");
    expect(zh.nav.event).toBe("活动中");
    expect(en.nav.event).toBe("Event");
  });

  it("treats absolute http(s) hrefs as external even without the flag", () => {
    expect(isExternalNavItem({ key: "x", href: "https://example.com" })).toBe(true);
    expect(isExternalNavItem({ key: "x", href: "http://example.com" })).toBe(true);
    expect(isExternalNavItem({ key: "x", href: "/vs" })).toBe(false);
  });
});
