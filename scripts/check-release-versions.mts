import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  RELEASE_VERSION_MANIFEST,
  RUNTIME_RELEASE_VERSIONS,
  changedVersionComponents,
  releaseVersionErrors,
  type ReleaseVersionManifest,
} from "../src/lib/release-versions";

const MANIFEST_PATH = "config/release-versions.json";
const VERSION_SOURCES = {
  score: { path: "src/lib/cache-version.ts", name: "SCORE_CACHE_VERSION" },
  roast: { path: "src/lib/cache-version.ts", name: "ROAST_CACHE_VERSION" },
  collection: {
    path: "src/lib/scan-run-types.ts",
    name: "PUBLIC_SCAN_COLLECTION_VERSION",
  },
} as const;

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function baseManifest(ref: string): ReleaseVersionManifest | null {
  try {
    return JSON.parse(git("show", `${ref}:${MANIFEST_PATH}`)) as ReleaseVersionManifest;
  } catch {
    return null;
  }
}

function exportedStringConstant(source: string, fileName: string, name: string): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer &&
        ts.isStringLiteral(declaration.initializer)
      ) {
        return declaration.initializer.text;
      }
    }
  }
  throw new Error(`${name} must be an exported string constant in ${fileName}`);
}

function versionsAt(ref?: string) {
  const read = (source: (typeof VERSION_SOURCES)[keyof typeof VERSION_SOURCES]) => {
    const text = ref
      ? git("show", `${ref}:${source.path}`)
      : readFileSync(resolve(source.path), "utf8");
    return exportedStringConstant(text, source.path, source.name);
  };
  return {
    score: read(VERSION_SOURCES.score),
    roast: read(VERSION_SOURCES.roast),
    collection: read(VERSION_SOURCES.collection),
  };
}

function versionChangeErrors(baseRef: string): string[] {
  const base = baseManifest(baseRef);
  if (!base) return [];

  const errors: string[] = [];
  const targetChanges = changedVersionComponents(
    base.targetRelease,
    RELEASE_VERSION_MANIFEST.targetRelease,
  );
  const runtimeChanges = changedVersionComponents(versionsAt(baseRef), versionsAt());
  const approvedIssue = RELEASE_VERSION_MANIFEST.changeControl.approvedMultiComponentIssue;
  const hasApproval = Number.isInteger(approvedIssue) && Number(approvedIssue) > 0;
  const isTrackedNormalization =
    base.runtimeEnforcement.state === "source_changes_only" &&
    RELEASE_VERSION_MANIFEST.runtimeEnforcement.state === "canonical" &&
    base.runtimeEnforcement.trackingIssue === 126 &&
    RELEASE_VERSION_MANIFEST.runtimeEnforcement.trackingIssue === null &&
    runtimeChanges.length > 0;

  if (runtimeChanges.length > 0 && !sameTarget(versionsAt(), RELEASE_VERSION_MANIFEST.targetRelease)) {
    errors.push("changed runtime constants must exactly match the formal target release");
  }

  if (targetChanges.length > 1 && !hasApproval) {
    errors.push(
      `formal release changes ${targetChanges.join(", ")}; multi-component bumps require an approved issue`,
    );
  }
  if (targetChanges.length > 0 && runtimeChanges.length === 0) {
    errors.push("a formal target change must include its isolated runtime version change");
  }
  if (runtimeChanges.length > 1 && !hasApproval && !isTrackedNormalization) {
    errors.push(
      `runtime changes ${runtimeChanges.join(", ")}; multi-component changes require an approved issue`,
    );
  }

  if (targetChanges.length > 0 || runtimeChanges.length > 0) {
    const changedFiles = git("diff", "--name-only", `${baseRef}...HEAD`).split("\n");
    if (!changedFiles.includes(RELEASE_VERSION_MANIFEST.releasePlan)) {
      errors.push("a version change must update its checked-in release and rollback plan");
    }
  }
  return errors;
}

function sameTarget(
  actual: typeof RUNTIME_RELEASE_VERSIONS,
  target: typeof RELEASE_VERSION_MANIFEST.targetRelease,
): boolean {
  return changedVersionComponents(actual, target).length === 0;
}

const errors = releaseVersionErrors();
const releasePlan = resolve(RELEASE_VERSION_MANIFEST.releasePlan);
if (!existsSync(releasePlan) || readFileSync(releasePlan, "utf8").trim().length === 0) {
  errors.push(`release plan is missing: ${RELEASE_VERSION_MANIFEST.releasePlan}`);
}

const baseRef = argument("--base-ref");
if (baseRef) errors.push(...versionChangeErrors(baseRef));

if (errors.length > 0) {
  for (const error of errors) console.error(`release-version check failed: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `formal release target verified (${RELEASE_VERSION_MANIFEST.targetRelease.score}/${RELEASE_VERSION_MANIFEST.targetRelease.roast}/${RELEASE_VERSION_MANIFEST.targetRelease.collection}, ${RELEASE_VERSION_MANIFEST.runtimeEnforcement.state})`,
  );
}
