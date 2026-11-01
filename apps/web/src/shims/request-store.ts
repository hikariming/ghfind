import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The request being rendered, entered by the middleware around every page so
 * request-scoped Next APIs used by shared code (`next/headers` cookies())
 * read it the way Next's own async storage would.
 */
export const requestStore = new AsyncLocalStorage<Request>();
