import { afterEach, expect, it, vi } from "vitest";
import * as bindings from "../d1-client";
import { reconcileFeedCatalog, reviewFeedTagProposal, syncFeedProjectProjection } from "../feed";
import type { ProjectAnalysisArtifact } from "../project-analysis-contract";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it.each(["outbox", "go"])("disables all old catalog mutation entrypoints before storage access in %s mode", async mode => {
  vi.stubEnv("FEED_SOURCE_OUTBOX_ENABLED", mode === "outbox" ? "true" : "false");
  vi.stubEnv("FEED_BACKEND", mode === "go" ? "go" : "legacy");
  const feed = vi.spyOn(bindings, "getFeedD1Binding").mockImplementation(() => { throw new Error("storage must not be reached"); });
  const core = vi.spyOn(bindings, "getD1Binding").mockImplementation(() => { throw new Error("storage must not be reached"); });
  for (const invoke of [
    () => syncFeedProjectProjection({} as ProjectAnalysisArtifact, "analysis-1"),
    () => reconcileFeedCatalog(100),
    () => reviewFeedTagProposal({ proposalId: "proposal-1", action: "reject", reviewer: "operator", reason: "Old writer must be disabled" }),
  ]) await expect(invoke()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Legacy Feed catalog writes are disabled") });
  expect(feed).not.toHaveBeenCalled();
  expect(core).not.toHaveBeenCalled();
});
