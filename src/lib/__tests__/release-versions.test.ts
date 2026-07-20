import { describe, expect, it } from "vitest";
import {
  RELEASE_VERSION_MANIFEST,
  changedVersionComponents,
  releaseVersionErrors,
  type ReleaseVersionManifest,
} from "../release-versions";

function manifestCopy(): ReleaseVersionManifest {
  return structuredClone(RELEASE_VERSION_MANIFEST);
}

describe("release version contract", () => {
  it("records only the formal v8/v8/v3 to v9/v9/v4 lineage", () => {
    expect(RELEASE_VERSION_MANIFEST.previousRelease).toEqual({
      score: "v8",
      roast: "v8",
      collection: "v3",
    });
    expect(RELEASE_VERSION_MANIFEST.targetRelease).toEqual({
      score: "v9",
      roast: "v9",
      collection: "v4",
    });
    expect(RELEASE_VERSION_MANIFEST.aliases).toEqual([]);
  });

  it("keeps runtime enforcement scoped to version-file changes until normalization", () => {
    expect(releaseVersionErrors()).toEqual([]);
    expect(RELEASE_VERSION_MANIFEST.runtimeEnforcement).toEqual({
      state: "source_changes_only",
      trackingIssue: 126,
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

  it("rejects aliases and accidental-version replay paths", () => {
    const aliasManifest = manifestCopy();
    aliasManifest.aliases = [{ from: "local", to: "formal" }];
    expect(releaseVersionErrors(aliasManifest)).toContain("version aliases are forbidden");

    const replayManifest = manifestCopy();
    replayManifest.compatibility.roastReplay = [{ score: "local", roast: "local" }];
    expect(releaseVersionErrors(replayManifest)).toContain(
      "roast replay must require the canonical score and roast pair",
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
});
