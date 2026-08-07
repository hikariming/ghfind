import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("home username links", () => {
  it("routes the generated score username to the internal profile page", () => {
    const roaster = source("Roaster.tsx");

    expect(roaster).toMatch(/import \{[^}]*\bLink\b[^}]*\} from "@\/i18n\/navigation";/);
    expect(roaster).toMatch(/<Link\s+href=\{`\/u\/\$\{scan\.metrics\.username\}`\}/);
    expect(roaster).not.toContain("href={scan.metrics.profile_url");
  });

  it("routes the leaderboard username to the same internal page as its row", () => {
    const leaderboard = source("LeaderboardClient.tsx");

    expect(leaderboard).toMatch(
      /<Link\s+href=\{`\/u\/\$\{e\.username\}`\}\s+prefetch=\{false\}[\s\S]*?@\{e\.username\}[\s\S]*?<\/Link>/,
    );
    expect(leaderboard).not.toContain("href={profileUrl}");
    expect(leaderboard).not.toContain("const profileUrl =");
  });

  it("sends the whole editor's-picks card to the collection, never to GitHub", () => {
    const card = source("CollectionPromoCard.tsx");

    // Stretched link covering the card — the only link it has.
    expect(card).toMatch(
      /<Link\s+href=\{`\/collections\/\$\{slug\}`\}[\s\S]*?className="absolute inset-0 z-0/,
    );
    expect(card.match(/<Link\b/g)).toHaveLength(1);
    expect(card).not.toContain("github.com");
  });
});
