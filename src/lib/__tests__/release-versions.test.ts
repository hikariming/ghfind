import { describe, expect, it } from "vitest";
import {
  RELEASE_VERSION_MANIFEST,
  changedVersionComponents,
  releaseVersionErrors,
  releaseTransitionErrors,
  type ReleaseVersionManifest,
} from "../release-versions";

function manifestCopy(): ReleaseVersionManifest {
  return structuredClone(RELEASE_VERSION_MANIFEST);
}

describe("release version contract", () => {
  it("records the isolated v9/v9/v4 to v9/v10/v4 roast release", () => {
    expect(RELEASE_VERSION_MANIFEST.previousRelease).toEqual({
      score: "v9",
      roast: "v9",
      collection: "v4",
    });
    expect(RELEASE_VERSION_MANIFEST.targetRelease).toEqual({
      score: "v9",
      roast: "v10",
      collection: "v4",
    });
    expect(RELEASE_VERSION_MANIFEST.aliases).toEqual([]);
  });

  it("keeps the v5/v5/v3 emergency reader outside the formal lineage", () => {
    expect(RELEASE_VERSION_MANIFEST.legacyReadFallback).toEqual({
      score: "v5",
      roast: "v5",
      collection: "v3",
    });
    expect(RELEASE_VERSION_MANIFEST.compatibility.roastReplay).toEqual([
      { score: "v9", roast: "v10" },
    ]);
    expect(RELEASE_VERSION_MANIFEST.compatibility.publicScoreReadOrder).toEqual(["v9"]);
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

  it("keeps the unchanged v4 collection in both isolated-release read slots", () => {
    expect(RELEASE_VERSION_MANIFEST.compatibility.collectionReadOrder).toEqual(["v4", "v4"]);
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
      "public score reads must only serve the canonical target release",
    );

    const changedFallback = manifestCopy();
    changedFallback.legacyReadFallback.score = "v6";
    expect(releaseVersionErrors(changedFallback)).toContain(
      "legacy read fallback must remain the exact v5/v5/v3 artifact tuple",
    );
  });

  it("detects multi-component changes for CI change control", () => {
    expect(
      changedVersionComponents(
        { score: "v9", roast: "v9", collection: "v4" },
        { score: "v10", roast: "v10", collection: "v4" },
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
