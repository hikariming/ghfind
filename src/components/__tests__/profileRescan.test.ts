import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const profileSource = readFileSync(
  new URL("../../app/[locale]/u/[username]/page.tsx", import.meta.url),
  "utf8",
);

describe("profile rescan", () => {
  it("offers a rescan on every stored profile", () => {
    expect(profileSource).toContain(
      '<RescanButton username={d.username} scannedAt={d.scanned_at} className="mt-3" />',
    );
    expect(profileSource).not.toMatch(/\{isOwner && \(\s*<RescanButton/);
  });
});
