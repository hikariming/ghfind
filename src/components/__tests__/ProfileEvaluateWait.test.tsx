import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProfileEvaluateWait } from "@/components/ProfileEvaluateWait";

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

describe("ProfileEvaluateWait", () => {
  it("mirrors the profile grid with a soft handle and active stage", () => {
    const html = renderToStaticMarkup(
      <ProfileEvaluateWait
        username="octo-demo"
        phase="analyze"
        stageLabel="Analyzing repos"
        stageLabels={["Fetching data", "Analyzing repos", "Writing the roast"]}
        percent={54}
        backLabel="Back"
      />,
    );
    expect(html).toContain("@octo-demo");
    expect(html).toContain("Analyzing repos");
    expect(html).toContain('data-profile-evaluate="analyze"');
    expect(html).toContain('data-phase="analyze"');
    expect(html).toContain('data-active="1"');
    expect(html).toContain("54%");
    expect(html).toContain("bg-white/[0.05]");
    expect(html).toContain("grid w-full grid-cols-3");
    expect(html).toContain("size-28");
    expect(html).toContain("safe-area-inset-bottom");
    expect(html).not.toContain("bg-black/35");
  });

  it("shows friendly timeout copy with an orange retry CTA", () => {
    const html = renderToStaticMarkup(
      <ProfileEvaluateWait
        username="octo-demo"
        phase="timeout"
        stageLabel="Writing the roast"
        stageLabels={["Fetching data", "Analyzing repos", "Writing the roast"]}
        percent={40}
        backLabel="Back"
        errorLabel="That took a bit long. Tap retry to try again."
        retryLabel="Retry"
        onRetry={() => undefined}
      />,
    );
    expect(html).toContain('data-profile-evaluate="timeout"');
    expect(html).toContain("That took a bit long. Tap retry to try again.");
    expect(html).toContain("Retry");
    expect(html).toContain("bg-orange-600");
  });
});
