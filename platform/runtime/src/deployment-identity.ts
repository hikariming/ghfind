import { HTTPError } from "./security";

type DeploymentSettings = Pick<RuntimeEnv, "FEED_ENVIRONMENT" | "FEED_RELEASE_SHA" | "FEED_MODE" | "FEED_WRITER_EPOCH"> & { FEED_IMAGE_BUILD_ID?: string };
declare const __FEED_DEPLOYMENT_IDENTITY__: unknown;

// Rendered into the actual Worker code for each release phase. Keep this check
// in DO construction: a code update replaces the old constructor-bound env;
// a bindings-only update must never be mistaken for that guarantee.
export function assertDeploymentIdentity(env: DeploymentSettings, compiled: unknown =
  typeof __FEED_DEPLOYMENT_IDENTITY__ === "undefined" ? undefined : __FEED_DEPLOYMENT_IDENTITY__): void {
  if (compiled === undefined && env.FEED_ENVIRONMENT !== "production") return;
  const identity = compiled as Record<string, unknown> | null;
  if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
      Object.keys(identity).sort().join(",") !== "imageBuildId,mode,sourceSha,writerEpoch" ||
      typeof identity.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(identity.sourceSha) ||
      typeof identity.imageBuildId !== "string" || !/^[a-f0-9]{64}$/.test(identity.imageBuildId) ||
      !["off", "baseline"].includes(String(identity.mode)) ||
      typeof identity.writerEpoch !== "string" || !/^[1-9][0-9]*$/.test(identity.writerEpoch) ||
      !Number.isSafeInteger(Number(identity.writerEpoch)) ||
      identity.sourceSha !== env.FEED_RELEASE_SHA || identity.imageBuildId !== env.FEED_IMAGE_BUILD_ID ||
      identity.mode !== env.FEED_MODE || identity.writerEpoch !== env.FEED_WRITER_EPOCH)
    throw new HTTPError(503, "runtime_deployment_identity_mismatch");
}
