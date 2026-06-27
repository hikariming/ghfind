import { describe, expect, it } from "vitest";
import { normalizePublicEmail } from "../github";

describe("normalizePublicEmail", () => {
  it("normalizes plain and mailto emails", () => {
    expect(normalizePublicEmail("  Dev@Example.COM ")).toBe("dev@example.com");
    expect(normalizePublicEmail("mailto:Dev%2BOSS@example.com?subject=hi")).toBe(
      "dev+oss@example.com",
    );
  });

  it("rejects invalid and GitHub noreply addresses", () => {
    expect(normalizePublicEmail("not an email")).toBeNull();
    expect(normalizePublicEmail("12345+octo@users.noreply.github.com")).toBeNull();
  });
});
