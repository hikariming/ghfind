import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ROAST_CACHE_VERSION, SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";
import {
  ProfileArtifactStatus,
  resolveProfileArtifactState,
  shouldStartProfileRoast,
} from "./ProfileArtifactStatus";

describe("profile artifact status", () => {
  const canonicalProvenance = {
    scoreVersion: SCORE_CACHE_VERSION,
    sourceCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    sourceSnapshotHash: "a".repeat(64),
  };

  it("keeps a non-canonical score visibly stale even if a report version is present", () => {
    expect(
      resolveProfileArtifactState({
        ...canonicalProvenance,
        scoreVersion: `${SCORE_CACHE_VERSION}-previous`,
        roastVersion: ROAST_CACHE_VERSION,
      }),
    ).toBe("stale-score");
  });

  it("keeps a canonical-version score stale without canonical provenance", () => {
    expect(
      resolveProfileArtifactState({
        ...canonicalProvenance,
        sourceCollectionVersion: null,
        roastVersion: ROAST_CACHE_VERSION,
      }),
    ).toBe("stale-score");
    expect(
      resolveProfileArtifactState({
        ...canonicalProvenance,
        sourceSnapshotHash: null,
        roastVersion: ROAST_CACHE_VERSION,
      }),
    ).toBe("stale-score");
    expect(
      resolveProfileArtifactState({
        ...canonicalProvenance,
        sourceSnapshotHash: "not-a-sha256",
        roastVersion: ROAST_CACHE_VERSION,
      }),
    ).toBe("stale-score");
  });

  it("marks a canonical score without a canonical report as pending", () => {
    expect(
      resolveProfileArtifactState({
        ...canonicalProvenance,
        roastVersion: null,
      }),
    ).toBe("report-pending");
    expect(
      resolveProfileArtifactState({
        ...canonicalProvenance,
        roastVersion: `${ROAST_CACHE_VERSION}-previous`,
      }),
    ).toBe("report-pending");
  });

  it("only marks the canonical score and report pair ready", () => {
    expect(
      resolveProfileArtifactState({
        ...canonicalProvenance,
        roastVersion: ROAST_CACHE_VERSION,
      }),
    ).toBe("ready");
  });

  it("renders a stable state marker with accessible status copy", () => {
    const html = renderToStaticMarkup(
      <ProfileArtifactStatus
        state="report-pending"
        title="Current score"
        body="Report pending"
      />,
    );

    expect(html).toContain('data-profile-artifact-state="report-pending"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Current score");
    expect(html).toContain("Report pending");
  });

  it("never starts an LLM roast on an ordinary direct profile visit", () => {
    expect(
      shouldStartProfileRoast({
        explicitHandoff: false,
        hasReport: false,
        staleReport: false,
      }),
    ).toBe(false);
    expect(
      shouldStartProfileRoast({
        explicitHandoff: false,
        hasReport: true,
        staleReport: true,
      }),
    ).toBe(false);
  });

  it("preserves live generation only for an explicit handoff that needs it", () => {
    expect(
      shouldStartProfileRoast({
        explicitHandoff: true,
        hasReport: false,
        staleReport: false,
      }),
    ).toBe(true);
    expect(
      shouldStartProfileRoast({
        explicitHandoff: true,
        hasReport: true,
        staleReport: true,
      }),
    ).toBe(true);
    expect(
      shouldStartProfileRoast({
        explicitHandoff: true,
        hasReport: true,
        staleReport: false,
      }),
    ).toBe(false);
  });
});
