import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("hosted CLI and Agent Skill assets", () => {
  it("resolves integration copy from nested message keys in every locale", () => {
    for (const file of readdirSync("src/messages").filter(name => name.endsWith(".json"))) {
      const messages = JSON.parse(readFileSync(`src/messages/${file}`, "utf8")) as {
        integrations: { install: { heading: string }; tokens: { heading: string; signIn: string } };
      };
      expect(messages.integrations.install.heading, file).toBeTruthy();
      expect(messages.integrations.tokens.heading, file).toBeTruthy();
      expect(messages.integrations.tokens.signIn, file).toBeTruthy();
    }
    const zh = JSON.parse(readFileSync("src/messages/zh.json", "utf8")) as {
      integrations: { install: { heading: string }; tokens: { heading: string } };
    };
    expect(zh.integrations.install.heading).toBe("一条命令，安装 CLI 和 Skill");
    expect(zh.integrations.tokens.heading).toBe("创建 API Token");
  });

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
