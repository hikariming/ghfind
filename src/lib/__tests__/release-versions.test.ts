import { describe, expect, it } from "vitest";
import {
  RELEASE_VERSION_MANIFEST,
  isRetainedPublicScoreArtifact,
  changedVersionComponents,
  releaseVersionErrors,
  releaseTransitionErrors,
  type ReleaseVersionManifest,
} from "../release-versions";

function manifestCopy(): ReleaseVersionManifest {
  // Historical score-transition baseline keeps transition cases independent of the active release.
  return { ...structuredClone(RELEASE_VERSION_MANIFEST),
    previousRelease: { score: "v10", roast: "v12", collection: "v5" },
    targetRelease: { score: "v13", roast: "v12", collection: "v5" },
    skippedScoreVersions: ["v11", "v12"],
    legacyReadFallback: { score: "v10", roast: "v12", collection: "v5" },
    compatibility: { publicScoreReadOrder: ["v13", "v10"], collectionReadOrder: ["v5"], roastReplay: [{ score: "v13", roast: "v12" }] },
  };
}

describe("release version contract", () => {
  it("retains hashed v10/v5 history without making it canonical", () => {
    expect(isRetainedPublicScoreArtifact("v10", "v5", "a".repeat(64))).toBe(true);
    expect(isRetainedPublicScoreArtifact("v13", "v5", "a".repeat(64))).toBe(true);
  });

  it("advances score alone to v17 and retains v16/v15/v14/v13/v10", () => {
    expect(RELEASE_VERSION_MANIFEST.previousRelease).toEqual({ score: "v16", roast: "v12", collection: "v6" });
    expect(RELEASE_VERSION_MANIFEST.targetRelease).toEqual({ score: "v17", roast: "v12", collection: "v6" });
    expect(RELEASE_VERSION_MANIFEST.legacyReadFallback).toEqual(RELEASE_VERSION_MANIFEST.previousRelease);
    expect(RELEASE_VERSION_MANIFEST.compatibility.publicScoreReadOrder).toEqual(["v17", "v16", "v15", "v14", "v13", "v10"]);
  });

  it("cannot introduce a newly readable score through collection compatibility", () => {
    const before = manifestCopy();
    const after = structuredClone(RELEASE_VERSION_MANIFEST);
    after.compatibility.retainedPublicScoreVersions = ["v9"];
    after.compatibility.publicScoreReadOrder = ["v13", "v9"];
    expect(releaseTransitionErrors({ beforeManifest: before, afterManifest: after,
      beforeRuntime: before.targetRelease, afterRuntime: after.targetRelease })).toContain(
      "retained public score versions must already be readable before this release",
    );
  });

  it("requires the runtime to remain on the canonical release after normalization", () => {
    expect(releaseVersionErrors()).toEqual([]);
    expect(RELEASE_VERSION_MANIFEST.runtimeEnforcement).toEqual({
      state: "canonical",
      trackingIssue: null,
    });
  });

  it("requires canonical runtime constants to equal the formal target", () => {
    const manifest = manifestCopy();
    manifest.runtimeEnforcement = {
      state: "canonical",
      trackingIssue: null,
    };

    expect(releaseVersionErrors(manifest, manifest.targetRelease)).toEqual([]);
  });

  it("keeps v5 history behind collection v6", () => {
    expect(RELEASE_VERSION_MANIFEST.compatibility.collectionReadOrder).toEqual(["v6", "v5"]);
  });

  it("includes the previous collection only after a collection-version change", () => {
    const manifest = manifestCopy();
    manifest.previousRelease = { ...manifest.targetRelease };
    manifest.targetRelease = { ...manifest.targetRelease, collection: "v6" };
    manifest.legacyReadFallback = { ...manifest.previousRelease };
    manifest.compatibility.collectionReadOrder = ["v6", "v5"];
    manifest.compatibility.publicScoreReadOrder = [manifest.targetRelease.score];

    expect(
      releaseVersionErrors(manifest, { ...manifest.targetRelease }),
    ).toEqual([]);
  });

  it("rejects aliases and accidental-version replay paths", () => {
    const aliasManifest = manifestCopy();
    aliasManifest.aliases = [{ from: "local", to: "formal" }];
    expect(releaseVersionErrors(aliasManifest)).toContain("version aliases are forbidden");

    const replayManifest = manifestCopy();
    replayManifest.compatibility.roastReplay = [{ score: "local", roast: "local" }];
    expect(releaseVersionErrors(replayManifest)).toContain(
      "roast replay must require the canonical score and roast pair",
    );

    const stalePublicRead = manifestCopy();
    stalePublicRead.compatibility.publicScoreReadOrder = ["v9", "v8"];
    expect(releaseVersionErrors(stalePublicRead)).toContain(
      "public score reads must prefer the canonical target and keep the previous score only after a score-version advance",
    );

    const changedFallback = manifestCopy();
    changedFallback.legacyReadFallback.score = "v6";
    expect(releaseVersionErrors(changedFallback)).toContain(
      "legacy read fallback must be the previous release or its retained previous-score tuple",
    );
  });

  it("allows a score rollback to a previously shipped version", () => {
    const manifest = manifestCopy();
    manifest.previousRelease = { score: "v13", roast: "v12", collection: "v5" };
    manifest.targetRelease = { score: "v10", roast: "v12", collection: "v5" };
    manifest.skippedScoreVersions = [];
    manifest.legacyReadFallback = { ...manifest.previousRelease };
    manifest.compatibility.publicScoreReadOrder = ["v10"];
    manifest.compatibility.roastReplay = [{ score: "v10", roast: "v12" }];
    expect(releaseVersionErrors(manifest, manifest.targetRelease)).toEqual([]);
  });

  it("rejects a score jump that does not list the retired labels it skips", () => {
    const manifest = manifestCopy();
    manifest.skippedScoreVersions = ["v11"];
    expect(releaseVersionErrors(manifest, manifest.targetRelease)).toContain(
      "score target must stay put, advance by exactly one formal version, skip only retired labels, or roll back to a previously shipped version",
    );
  });

  it("detects multi-component changes for CI change control", () => {
    expect(
      changedVersionComponents(
        { score: "v9", roast: "v9", collection: "v4" },
        { score: "v11", roast: "v10", collection: "v4" },
      ),
    ).toEqual(["score", "roast"]);
  });

  it("does not allow an approval field to bypass isolated version changes", () => {
    const manifest = manifestCopy();
    manifest.changeControl.approvedMultiComponentIssue = 999;
    expect(releaseVersionErrors(manifest)).toContain(
      "multi-component version changes are forbidden after normalization",
    );
  });

  it("allows only the tracked one-time normalization to change all runtime constants", () => {
    const before = manifestCopy();
    before.runtimeEnforcement = { state: "source_changes_only", trackingIssue: 126 };
    expect(
      releaseTransitionErrors({
        beforeManifest: before,
        afterManifest: manifestCopy(),
        beforeRuntime: { score: "v99", roast: "v99", collection: "v99" },
        afterRuntime: manifestCopy().targetRelease,
      }),
    ).toEqual([]);
  });

  it("rejects a future three-component bump even when manifest and runtime agree", () => {
    const before = manifestCopy();
    before.previousRelease = { score: "v20", roast: "v20", collection: "v20" };
    before.targetRelease = { score: "v21", roast: "v21", collection: "v21" };
    const after = structuredClone(before);
    after.previousRelease = { ...before.targetRelease };
    after.targetRelease = { score: "v22", roast: "v22", collection: "v22" };
    expect(
      releaseTransitionErrors({
        beforeManifest: before,
        afterManifest: after,
        beforeRuntime: { ...before.targetRelease },
        afterRuntime: { ...after.targetRelease },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("multi-component bumps are forbidden"),
        expect.stringContaining("multi-component changes are forbidden"),
      ]),
    );
  });

  it("rejects rewriting release history without advancing the target", () => {
    const before = manifestCopy();
    const after = manifestCopy();
    after.previousRelease.score = "v7";
    expect(
      releaseTransitionErrors({
        beforeManifest: before,
        afterManifest: after,
        beforeRuntime: { ...before.targetRelease },
        afterRuntime: { ...after.targetRelease },
      }),
    ).toContain("previousRelease cannot change without advancing the formal target");
  });
});


it("forbids rotating the read-only fallback in a roast-only transition", () => {
  const before = manifestCopy();
  const after = manifestCopy();
  after.previousRelease = { ...before.targetRelease };
  after.targetRelease.roast = "v13";
  after.legacyReadFallback = { ...before.targetRelease };
  const input = { beforeManifest: before, afterManifest: after,
    beforeRuntime: before.targetRelease, afterRuntime: after.targetRelease };
  expect(releaseTransitionErrors(input)).toContain("roast-only releases must preserve the existing read-only fallback");
  after.legacyReadFallback = { ...before.legacyReadFallback };
  expect(releaseTransitionErrors(input)).toEqual([]);
});
