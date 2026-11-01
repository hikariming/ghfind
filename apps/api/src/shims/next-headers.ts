/**
 * `next/headers` shim (wired via the wrangler `alias`). Next serves cookies()
 * and headers() from per-request async storage; this Worker does the same
 * (src/request-context.ts). cookies() is read-only here, matching what route
 * handlers rely on.
 */
import { RequestCookies } from "next/dist/server/web/spec-extension/cookies";
import { currentRequestContext } from "../request-context";

export async function cookies() {
  return new RequestCookies(currentRequestContext("cookies()").request.headers);
}

export async function headers() {
  return currentRequestContext("headers()").request.headers;
}
