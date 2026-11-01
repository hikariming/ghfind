/**
 * `next/server` shim (wired via the wrangler `alias`): Next's own NextRequest /
 * NextResponse classes, imported from their standalone spec-extension modules
 * so cookie parsing/serialization (@edge-runtime/cookies), redirects and JSON
 * responses are byte-identical to the legacy Worker — without bundling the rest
 * of `next/server`. Add exports here only as route handlers need them.
 */
import { currentRequestContext } from "../request-context";

export { NextRequest } from "next/dist/server/web/spec-extension/request";
export { NextResponse } from "next/dist/server/web/spec-extension/response";

/**
 * Next's `after()`: run work once the response is on its way, kept alive by
 * the platform's waitUntil (what OpenNext maps it to). Failures are logged,
 * never surfaced to the already-sent response.
 */
export function after<T>(task: Promise<T> | (() => T | Promise<T>)): void {
  const { waitUntil } = currentRequestContext("after()");
  waitUntil(
    new Promise((resolve) => setTimeout(resolve, 0))
      .then(() => (typeof task === "function" ? task() : task))
      .catch((error) => console.error("after.failed", error)),
  );
}
