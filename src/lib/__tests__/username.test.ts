import { describe, expect, it } from "vitest";
import { normalizeUsername } from "../username";

describe("normalizeUsername", () => {
  it("normalizes handles, @handles, and profile URLs", () => {
    expect(normalizeUsername("octocat")).toBe("octocat");
    expect(normalizeUsername("  @octocat ")).toBe("octocat");
    expect(normalizeUsername("https://github.com/octocat?tab=repos")).toBe("octocat");
  });

  // New signups can't take underscores, but legacy accounts and Enterprise
  // Managed Users (`login_shortcode`) have them — they must scan like anyone.
  it("accepts underscores in legacy/EMU logins", () => {
    expect(normalizeUsername("mona_lisa")).toBe("mona_lisa");
    expect(normalizeUsername("@octo_cat_corp")).toBe("octo_cat_corp");
    expect(normalizeUsername("https://github.com/octo_cat")).toBe("octo_cat");
    expect(normalizeUsername("under_score-hyphen")).toBe("under_score-hyphen");
  });

  it("rejects invalid logins", () => {
    expect(normalizeUsername("")).toBeNull();
    expect(normalizeUsername("-leading")).toBeNull();
    expect(normalizeUsername("double--hyphen")).toBeNull();
    expect(normalizeUsername("a".repeat(40))).toBeNull();
  });

  // Scripted clients POST bodies like {"username": 123} — must be a clean
  // null (→ 400), never a TypeError on .trim() (→ 500).
  it("returns null for non-string input instead of throwing", () => {
    expect(normalizeUsername(123)).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
    expect(normalizeUsername(undefined)).toBeNull();
    expect(normalizeUsername(["octocat"])).toBeNull();
    expect(normalizeUsername({ username: "octocat" })).toBeNull();
  });
});
