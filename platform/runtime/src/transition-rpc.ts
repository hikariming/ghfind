import { HTTPError } from "./security";

// RPC preserves Error properties but not custom prototypes. Encode only errors
// created by our transition/probe code, before crossing the DO binding.
const errors = {
  invalid_transition: 400,
  transition_in_progress: 409,
  transition_timeout: 503,
  transition_stop_timeout: 503,
  container_version_or_contract_mismatch: 503,
  container_dependency_not_ready: 503,
  container_not_ready: 503,
  body_too_large: 413,
  body_timeout: 408,
} as const;

type TransitionErrorCode = keyof typeof errors;
export type TransitionResult<T> =
  | T
  | { kind: "http-error"; code: TransitionErrorCode; status: number };

function knownError(code: unknown, status: unknown): code is TransitionErrorCode {
  return typeof code === "string" && Object.hasOwn(errors, code) &&
    errors[code as TransitionErrorCode] === status;
}

export async function captureTransitionResult<T>(operation: () => Promise<T>): Promise<TransitionResult<T>> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HTTPError && knownError(error.code, error.status))
      return { kind: "http-error", code: error.code, status: error.status };
    throw error;
  }
}

export function readTransitionResult<T>(result: TransitionResult<T>): T {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const keys = Object.keys(result).sort().join(",");
    if ("kind" in result && result.kind === "http-error" && keys === "code,kind,status" &&
      "code" in result && "status" in result && knownError(result.code, result.status))
      throw new HTTPError(result.status as number, result.code);
    // Keep the legacy success receipt unchanged in either rollout direction.
    // The release caller still verifies every identity field against its manifest.
    if (keys === "imageBuildId,mode,restarted,sourceSha,target,writerEpoch" &&
      "restarted" in result && result.restarted === true) return result as T;
  }
  // An unknown binding reply is not permission to retry a lifecycle mutation.
  throw new Error("invalid transition RPC result");
}
