import manifestJson from "../../config/release-versions.json";
import { ROAST_CACHE_VERSION, SCORE_CACHE_VERSION } from "./cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "./scan-run-types";

export const RELEASE_COMPONENTS = ["score", "roast", "collection"] as const;
export type ReleaseComponent = (typeof RELEASE_COMPONENTS)[number];

export interface ReleaseVersionSet {
  score: string;
  roast: string;
  collection: string;
}

export interface ReleaseVersionManifest {
  schemaVersion: number;
  previousRelease: ReleaseVersionSet;
  targetRelease: ReleaseVersionSet;
  runtimeEnforcement: {
    state: "source_changes_only" | "canonical";
    trackingIssue: number | null;
  };
  compatibility: {
    publicScoreReadOrder: string[];
    roastReplay: { score: string; roast: string }[];
    collectionReadOrder: string[];
  };
  /**
   * A read-only emergency artifact tuple. It is never a canonical version,
   * replay alias, migration source, or queue target.
   */
  legacyReadFallback: ReleaseVersionSet;
  changeControl: {
    maxComponentsPerPullRequest: number;
    approvedMultiComponentIssue: number | null;
  };
  aliases: unknown[];
  releasePlan: string;
}

export const RELEASE_VERSION_MANIFEST = manifestJson as ReleaseVersionManifest;

/**
 * The only historical artifact tuple permitted for emergency reads. Keep this
 * separate from `compatibility`: normal public score reads serve v9 only.
 */
export const LEGACY_READ_FALLBACK: ReleaseVersionSet =
  RELEASE_VERSION_MANIFEST.legacyReadFallback;

const EXPECTED_LEGACY_READ_FALLBACK: ReleaseVersionSet = {
  score: "v5",
  roast: "v5",
  collection: "v3",
};

export const RUNTIME_RELEASE_VERSIONS: ReleaseVersionSet = {
  score: SCORE_CACHE_VERSION,
  roast: ROAST_CACHE_VERSION,
  collection: PUBLIC_SCAN_COLLECTION_VERSION,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && /^v[1-9]\d*$/.test(value);
}

function isVersionSet(value: unknown): value is ReleaseVersionSet {
  return (
    isRecord(value) &&
    RELEASE_COMPONENTS.every((component) => isVersion(value[component]))
  );
}

function sameVersions(a: ReleaseVersionSet, b: ReleaseVersionSet): boolean {
  return RELEASE_COMPONENTS.every((component) => a[component] === b[component]);
}

function exactList(actual: unknown, expected: string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function changedVersionComponents(
  before: ReleaseVersionSet,
  after: ReleaseVersionSet,
): ReleaseComponent[] {
  return RELEASE_COMPONENTS.filter((component) => before[component] !== after[component]);
}

/** Validate one release transition independently of GitHub event plumbing. */
export function releaseTransitionErrors(input: {
  beforeManifest: ReleaseVersionManifest;
  afterManifest: ReleaseVersionManifest;
  beforeRuntime: ReleaseVersionSet;
  afterRuntime: ReleaseVersionSet;
}): string[] {
  const errors: string[] = [];
  const targetChanges = changedVersionComponents(
    input.beforeManifest.targetRelease,
    input.afterManifest.targetRelease,
  );
  const runtimeChanges = changedVersionComponents(input.beforeRuntime, input.afterRuntime);
  const previousChanges = changedVersionComponents(
    input.beforeManifest.previousRelease,
    input.afterManifest.previousRelease,
  );
  const isTrackedNormalization =
    input.beforeManifest.runtimeEnforcement.state === "source_changes_only" &&
    input.afterManifest.runtimeEnforcement.state === "canonical" &&
    input.beforeManifest.runtimeEnforcement.trackingIssue === 126 &&
    input.afterManifest.runtimeEnforcement.trackingIssue === null &&
    targetChanges.length === 0 &&
    previousChanges.length === 0 &&
    runtimeChanges.length === RELEASE_COMPONENTS.length;

  if (
    runtimeChanges.length > 0 &&
    !sameVersions(input.afterRuntime, input.afterManifest.targetRelease)
  ) {
    errors.push("changed runtime constants must exactly match the formal target release");
  }
  if (targetChanges.length > 1) {
    errors.push(
      `formal release changes ${targetChanges.join(", ")}; multi-component bumps are forbidden`,
    );
  }
  if (targetChanges.length > 0 && runtimeChanges.length === 0) {
    errors.push("a formal target change must include its isolated runtime version change");
  }
  if (runtimeChanges.length > 1 && !isTrackedNormalization) {
    errors.push(
      `runtime changes ${runtimeChanges.join(", ")}; multi-component changes are forbidden`,
    );
  }
  if (targetChanges.length === 0 && previousChanges.length > 0) {
    errors.push("previousRelease cannot change without advancing the formal target");
  }
  if (
    targetChanges.length > 0 &&
    !sameVersions(input.afterManifest.previousRelease, input.beforeManifest.targetRelease)
  ) {
    errors.push("a new release must carry the prior target forward as previousRelease");
  }
  return errors;
}

/**
 * Validate the checked-in release contract against the actual runtime constants.
 * Public reads use the compatibility matrix; rejected local values are never
 * aliases or migration sources.
 */
export function releaseVersionErrors(
  manifest: unknown = RELEASE_VERSION_MANIFEST,
  runtime: ReleaseVersionSet = RUNTIME_RELEASE_VERSIONS,
): string[] {
  const errors: string[] = [];
  if (!isRecord(manifest)) return ["release manifest must be an object"];

  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!isVersionSet(manifest.previousRelease)) errors.push("previousRelease is invalid");
  if (!isVersionSet(manifest.targetRelease)) errors.push("targetRelease is invalid");
  if (errors.length > 0) return errors;

  const typed = manifest as unknown as ReleaseVersionManifest;
  const { previousRelease, targetRelease } = typed;

  for (const component of RELEASE_COMPONENTS) {
    const previous = Number(previousRelease[component].slice(1));
    const target = Number(targetRelease[component].slice(1));
    if (target < previous || target - previous > 1) {
      errors.push(`${component} target must stay put or advance by exactly one formal version`);
    }
  }

  if (!isRecord(typed.runtimeEnforcement)) {
    errors.push("runtimeEnforcement is missing");
  } else if (typed.runtimeEnforcement.state === "source_changes_only") {
    if (
      !Number.isInteger(typed.runtimeEnforcement.trackingIssue) ||
      Number(typed.runtimeEnforcement.trackingIssue) < 1
    ) {
      errors.push("source_changes_only requires a normalization tracking issue");
    }
  } else if (typed.runtimeEnforcement.state === "canonical") {
    if (!sameVersions(runtime, targetRelease)) {
      errors.push("canonical runtime must exactly match targetRelease");
    }
    if (typed.runtimeEnforcement.trackingIssue !== null) {
      errors.push("canonical runtime must not retain a normalization issue");
    }
  } else {
    errors.push("runtimeEnforcement.state must be source_changes_only or canonical");
  }

  if (!isRecord(typed.compatibility)) {
    errors.push("compatibility matrix is missing");
  } else {
    if (!exactList(typed.compatibility.publicScoreReadOrder, [targetRelease.score])) {
      errors.push("public score reads must only serve the canonical target release");
    }
    const collectionReadOrder =
      targetRelease.collection === previousRelease.collection
        ? [targetRelease.collection]
        : [targetRelease.collection, previousRelease.collection];
    if (!exactList(typed.compatibility.collectionReadOrder, collectionReadOrder)) {
      errors.push(
        "collection reads must prefer target and include the previous release only after a collection-version change",
      );
    }
    const roastReplay = typed.compatibility.roastReplay;
    if (
      !Array.isArray(roastReplay) ||
      roastReplay.length !== 1 ||
      roastReplay[0]?.score !== targetRelease.score ||
      roastReplay[0]?.roast !== targetRelease.roast
    ) {
      errors.push("roast replay must require the canonical score and roast pair");
    }
  }

  if (
    !isVersionSet(typed.legacyReadFallback) ||
    !sameVersions(typed.legacyReadFallback, EXPECTED_LEGACY_READ_FALLBACK)
  ) {
    errors.push("legacy read fallback must remain the exact v5/v5/v3 artifact tuple");
  }

  if (!Array.isArray(typed.aliases) || typed.aliases.length !== 0) {
    errors.push("version aliases are forbidden");
  }
  if (typed.changeControl?.maxComponentsPerPullRequest !== 1) {
    errors.push("version changes must default to one component per pull request");
  }
  if (typed.changeControl?.approvedMultiComponentIssue !== null) {
    errors.push("multi-component version changes are forbidden after normalization");
  }
  if (!/^docs\/releases\/[a-z0-9][a-z0-9-]*\.md$/.test(typed.releasePlan)) {
    errors.push("releasePlan must point to a versioned document under docs/releases");
  }

  return errors;
}
