import type { RuntimeSettings, Target } from "./router";
import { HTTPError } from "./security";

export type RefreshRequest = {
  sourceSha: string; imageBuildId: string; mode: "baseline"; writerEpoch: 1;
  offVersionId: string; baselineVersionId: string; actorId: string;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalidCodes = ["invalid_refresh_shape", "invalid_refresh_identity", "invalid_refresh_edge_version", "invalid_refresh_actor_version", "invalid_refresh_actor_scope"] as const;
type InvalidCode = typeof invalidCodes[number];
export function validateRefresh(value: unknown, env: RuntimeSettings, actorId: string, phase: "edge" | "actor"): asserts value is RefreshRequest {
  const d = value as RefreshRequest;
  if (!d || typeof d !== "object" || Array.isArray(d) ||
      Object.keys(d).sort().join(",") !== "actorId,baselineVersionId,imageBuildId,mode,offVersionId,sourceSha,writerEpoch" ||
      typeof d.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(d.sourceSha) ||
      typeof d.imageBuildId !== "string" || !/^[a-f0-9]{64}$/.test(d.imageBuildId) ||
      d.mode !== "baseline" || d.writerEpoch !== 1 ||
      typeof d.offVersionId !== "string" || !uuid.test(d.offVersionId) ||
      typeof d.baselineVersionId !== "string" || !uuid.test(d.baselineVersionId) || d.offVersionId === d.baselineVersionId ||
      typeof d.actorId !== "string" || !/^[a-f0-9]{64}$/.test(d.actorId))
    throw new HTTPError(400, "invalid_refresh_shape");
  if (env.FEED_ENVIRONMENT !== "production" || d.sourceSha !== env.FEED_RELEASE_SHA ||
      d.imageBuildId !== env.FEED_IMAGE_BUILD_ID || env.FEED_WRITER_EPOCH !== "1")
    throw new HTTPError(400, "invalid_refresh_identity");
  if (d.actorId !== actorId) throw new HTTPError(400, "invalid_refresh_actor_scope");
  if (env.FEED_MODE !== (phase === "edge" ? "baseline" : "off") ||
      env.WORKER_VERSION.id !== (phase === "edge" ? d.baselineVersionId : d.offVersionId))
    throw new HTTPError(400, phase === "edge" ? "invalid_refresh_edge_version" : "invalid_refresh_actor_version");
}
export type RefreshFailure =
  | { kind: "refresh-rejected"; status: 400 | 409; code: InvalidCode | "transition_in_progress" }
  | { kind: "refresh-already-current"; workerVersionId: string };
// Every accepted race must pass the same immutable identity and namespace
// guards. It is evidence for GET reconciliation, never permission to repeat POST.
export function refreshActor(input: unknown, env: RuntimeSettings, target: Target, actorId: string,
  expectedActorId: string, service: "api" | "executor", busy: boolean, abort: () => void): RefreshFailure {
  try {
    const current = env.FEED_MODE === "baseline";
    validateRefresh(input, env, actorId, current ? "edge" : "actor");
    if (actorId !== expectedActorId || !(service === "api" ? ["api-0", "api-1"] : ["executor-0"]).includes(target))
      throw new HTTPError(400, "invalid_refresh_actor_scope");
    if (busy) throw new HTTPError(409, "transition_in_progress");
    if (current) return { kind: "refresh-already-current", workerVersionId: env.WORKER_VERSION.id };
  } catch (error) {
    if (error instanceof HTTPError && (invalidCodes.includes(error.code as InvalidCode) || error.code === "transition_in_progress"))
      return { kind: "refresh-rejected", status: error.status as 400 | 409, code: error.code === "invalid_refresh_edge_version" ? "invalid_refresh_actor_version" : error.code as InvalidCode | "transition_in_progress" };
    throw error;
  }
  abort();
  throw new Error("refresh_outcome_unknown");
}
export function readRefreshFailure(value: unknown, baselineVersionId: string): string {
  const d = value as RefreshFailure;
  if (d && typeof d === "object") {
    const keys = Object.keys(d).sort().join(",");
    if (keys === "kind,workerVersionId" && d.kind === "refresh-already-current" && d.workerVersionId === baselineVersionId)
      return d.workerVersionId;
    if (keys === "code,kind,status" && d.kind === "refresh-rejected" &&
        ((d.status === 400 && invalidCodes.includes(d.code as InvalidCode)) || (d.status === 409 && d.code === "transition_in_progress")))
      throw new HTTPError(d.status, d.code);
  }
  throw new HTTPError(503, "refresh_outcome_unknown");
}
