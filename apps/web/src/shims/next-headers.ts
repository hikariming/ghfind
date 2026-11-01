/**
 * `next/headers` shim: cookies()/headers() for the request being rendered
 * (see request-store.ts). Read-only, which is all shared page code needs.
 */
import { RequestCookies } from "next/dist/server/web/spec-extension/cookies";
import { requestStore } from "./request-store";

function current(api: string): Request {
  const request = requestStore.getStore();
  if (!request) throw new Error(`${api} called outside a request`);
  return request;
}

export async function cookies() {
  return new RequestCookies(current("cookies()").headers);
}

export async function headers() {
  return current("headers()").headers;
}
