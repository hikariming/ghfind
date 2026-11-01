/**
 * Per-request state that Next keeps in its own async storage: the incoming
 * request (next/headers) and the platform's waitUntil (next/server `after`).
 * index.ts enters it around every route handler.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  request: Request;
  waitUntil(promise: Promise<unknown>): void;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(api: string): RequestContext {
  const context = requestContext.getStore();
  if (!context) throw new Error(`${api} called outside a request`);
  return context;
}
