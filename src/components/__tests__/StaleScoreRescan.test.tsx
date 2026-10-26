import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import zh from "@/messages/zh.json";
import en from "@/messages/en.json";
import { ProfileArtifactStatus } from "@/app/[locale]/u/[username]/ProfileArtifactStatus";
import { StaleScoreRescan, autoRescanSessionKey } from "../StaleScoreRescan";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function render(locale: "zh" | "en", auto: boolean) {
  const messages = locale === "zh" ? zh : en;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ProfileArtifactStatus
        state="stale-score"
        title={messages.detail.scoreStateStaleTitle}
        body={messages.detail.scoreStateStaleBody}
        action={<StaleScoreRescan username="DemoDev" auto={auto} />}
      />
    </NextIntlClientProvider>,
  );
}

describe("StaleScoreRescan", () => {
  it("puts a 重新评测 action inside the 历史评分 notice", () => {
    const html = render("zh", true);
    expect(html).toContain('data-profile-artifact-state="stale-score"');
    expect(html).toContain("历史评分");
    expect(html).toContain("重新评测");
    expect(html).toContain('data-stale-rescan="auto"');
    // Server render never starts the automatic run (it waits for hydration + interaction).
    expect(html).not.toContain("正在按新版规则重新评测");
  });

  it("renders the localized action without auto mode", () => {
    const html = render("en", false);
    expect(html).toContain("Re-evaluate");
    expect(html).toContain('data-stale-rescan="manual"');
  });

  it("keys the once-per-session guard case-insensitively", () => {
    expect(autoRescanSessionKey("DemoDev")).toBe(autoRescanSessionKey("demodev"));
  });
});
