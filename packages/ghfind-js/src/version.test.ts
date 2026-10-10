import { describe, expect, it } from "vitest";
import cases from "../../../tests/fixtures/cli/versions.json";
import { isNewerVersion } from "./version";

describe("release version precedence (shared with Go CLI)", () => {
  it.each(cases)("$latest vs $current", ({ latest, current, newer, comparable }) => {
    expect(isNewerVersion(latest, current)).toEqual({ newer, comparable });
  });
  it("treats a missing release tag as incomparable", () => {
    expect(isNewerVersion(undefined, "1.0.0")).toEqual({ newer: false, comparable: false });
  });
});
