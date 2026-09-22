import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  setRequestLocale: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({ Link: "a" }));
vi.mock("@/components/ProjectAnalysisForm", () => ({ ProjectAnalysisForm: () => null }));
vi.mock("@/components/ProjectAssessmentCard", () => ({ ProjectAssessmentCard: () => null }));
vi.mock("@/lib/project-analysis-db", () => ({
  listProjectBoard: vi.fn(),
  countProjectBoard: vi.fn(),
}));

import ProjectsPage from "@/app/[locale]/projects/page";
import { listProjectBoard, countProjectBoard } from "../project-analysis-db";
import { redirect } from "next/navigation";

afterEach(() => vi.restoreAllMocks());

describe("project board availability", () => {
  it.each(["list", "count"])("renders a recoverable notice when %s fails with an upstream error", async (stage) => {
    vi.mocked(listProjectBoard).mockReset().mockResolvedValue([]);
    vi.mocked(countProjectBoard).mockReset().mockResolvedValue(0);
    vi.mocked(redirect).mockClear();
    const error = new Error("Server returned HTTP status 502");
    if (stage === "list") vi.mocked(listProjectBoard).mockRejectedValue(error);
    else vi.mocked(countProjectBoard).mockRejectedValue(error);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(await ProjectsPage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ page: "3" }),
    }));
    expect(html).toContain("databaseUnavailable");
    expect(html).not.toContain("emptyTitle");
    expect(html).not.toContain('name="page"');
    expect(redirect).not.toHaveBeenCalled();
  });
});
