import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modalSource = readFileSync(new URL("../RoastResultModal.tsx", import.meta.url), "utf8");
const profileSource = readFileSync(
  new URL("../../app/[locale]/u/[username]/page.tsx", import.meta.url),
  "utf8",
);

describe("RoastResultModal ADVX material card", () => {
  it("shows the generated material card after the roast settles", () => {
    expect(modalSource).toMatch(/advx && !pendingLine[\s\S]*?<MaterialCardPreview/);
  });

  it("replaces the flex-image save action with the material-card download", () => {
    expect(modalSource).toMatch(/saveAction=[\s\S]*?<MaterialCardSaveButton/);
    expect(modalSource).toContain('surface="modal"');
  });

  it("passes the ADVX context from the profile route into result popups", () => {
    expect(profileSource).toContain("advx={isAdvxCampaign}");
  });
});
