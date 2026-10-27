import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import zh from "@/messages/zh.json";
import en from "@/messages/en.json";
import { AutoReroast } from "../AutoReroast";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function render(locale: "zh" | "en", staleReport: string | null) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <AutoReroast
        username="DemoDev"
        lang={locale}
        staleReport={staleReport ? <p data-testid="stale">{staleReport}</p> : null}
      />
    </NextIntlClientProvider>,
  );
}

describe("AutoReroast", () => {
  it("never renders the 'not archived' empty state; keeps the manual 重新评测 action", () => {
    const html = render("zh", null);
    expect(html).toContain('data-auto-reroast="idle"');
    expect(html).not.toContain(zh.detail.roastEmpty.split("<")[0]);
    expect(html).toContain(zh.detail.roastRegeneratePending);
    expect(html).toContain("重新评测");
    expect(html).toContain('data-stale-rescan="manual"');
    // Server render never starts the job (hydration + interaction first).
    expect(html).not.toContain(zh.detail.roastRegenerating);
  });

  it("labels a previous-release report as 旧版锐评", () => {
    const html = render("zh", "上一版锐评正文");
    expect(html).toContain("旧版锐评");
    expect(html).toContain(zh.detail.roastStaleHint);
    expect(html).toContain("上一版锐评正文");
  });

  it("localizes the labels", () => {
    const html = render("en", "Previous report body");
    expect(html).toContain(en.detail.roastStaleLabel);
    expect(html).toContain("Re-evaluate");
  });
});
