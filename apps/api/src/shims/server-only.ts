/**
 * `server-only` shim (wired via the wrangler `alias`). The real package throws
 * unless resolved under React's "react-server" condition; this Worker is
 * server-only by construction, so the guard is a no-op here.
 */
export {};
