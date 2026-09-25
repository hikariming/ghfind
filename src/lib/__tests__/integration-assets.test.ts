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
    const productionCommand = "curl -fsSL https://ghfind.com/install.sh | bash";
    expect(page).toContain(productionCommand);
    expect(page).toContain("${SITE_URL}/install.sh | GHFIND_INSTALL_HOST=${SITE_URL} bash");
    expect(docs).toContain(productionCommand);
    expect(installer).toContain("GHFIND_INSTALL_HOST:-https://ghfind.com");
    expect(installer).toContain("${install_host}/skill.md");
    expect(installer).toContain("@hikariming/ghfind");
  });
});
