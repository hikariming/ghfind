import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("hosted CLI and Agent Skill assets", () => {
  it("keeps the public Skill aligned with the maintained source", () => {
    expect(readFileSync("public/skill.md", "utf8")).toBe(readFileSync("skills/ghfind-cli/SKILL.md", "utf8"));
  });

  it("publishes the exact command shown on the integration page", () => {
    const page = readFileSync("src/app/[locale]/integrations/page.tsx", "utf8");
    const installer = readFileSync("public/install.sh", "utf8");
    const docs = readFileSync("public/cli.md", "utf8");
    const command = "curl -fsSL https://ghfind.com/install.sh | bash";
    expect(page).toContain(command);
    expect(docs).toContain(command);
    expect(installer).toContain("https://ghfind.com/skill.md");
    expect(installer).toContain("@hikariming/ghfind");
  });
});
