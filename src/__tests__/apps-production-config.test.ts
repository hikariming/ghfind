import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderWeb } from "../../scripts/feed-production-release.mjs";

/**
 * The production api Worker serves routes that used to run on the legacy Web
 * Worker, whose configuration is rendered by the release (renderWeb), not by
 * wrangler.jsonc. Everything those routes read must match it, or behaviour
 * silently diverges (e.g. project analyses writing through the Feed writer
 * fence). Only Feed's own rollout/runtime keys stay legacy-only: Feed routes
 * are not served by the api Worker.
 */
const LEGACY_ONLY = new Set([
  "FEED_API_ORIGIN", "FEED_STORE_PROFILE", "FEED_RELEASE_SHA",
  "FEED_ROLLOUT_MODE", "FEED_ROLLOUT_GITHUB_IDS", "FEED_ROLLOUT_SEED", "FEED_ROLLOUT_BASIS_POINTS",
]);

function wranglerEnv(path: string, env: string) {
  const text = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text).env[env];
}

describe("production web Worker configuration", () => {
  // apps/web pages run the same src/lib data code as the API Worker.
  const web = wranglerEnv("apps/web/wrangler.jsonc", "production");
  const api = wranglerEnv("apps/api/wrangler.jsonc", "production");

  it("matches the API Worker's vars and data bindings", () => {
    expect(web.vars).toEqual(api.vars);
    expect(web.d1_databases).toEqual(api.d1_databases);
    expect(web.kv_namespaces).toEqual(api.kv_namespaces);
    expect(web.durable_objects.bindings).toEqual(api.durable_objects.bindings);
  });

  it("reaches the production API Worker for session reads and owns no route", () => {
    expect(web.services).toEqual([{ binding: "API", service: "ghfind-api" }]);
    expect(web.routes).toBeUndefined();
  });
});

describe("production api Worker configuration", () => {
  const api = wranglerEnv("apps/api/wrangler.jsonc", "production");
  const legacy = renderWeb("0".repeat(40), "all", api.vars);

  it("matches every legacy var the migrated routes can read", () => {
    const expected = Object.fromEntries(Object.entries(legacy.vars as Record<string, string>).filter(([k]) => !LEGACY_ONLY.has(k)));
    expect(api.vars).toEqual(expected);
  });

  it("uses the same databases, cache namespace and coordination objects", () => {
    const ids = (dbs: { binding: unknown; database_id: unknown }[]) => dbs.map((d) => [d.binding, d.database_id]);
    expect(ids(api.d1_databases)).toEqual(ids(legacy.d1_databases));
    expect(api.kv_namespaces).toEqual(legacy.kv_namespaces);
    expect(api.durable_objects.bindings).toEqual(legacy.durable_objects.bindings);
  });

  it("gives the ghfind.com custom domain to the router only", () => {
    const router = wranglerEnv("apps/router/wrangler.jsonc", "production");
    expect(router.routes).toEqual([{ pattern: "ghfind.com", custom_domain: true }]);
    expect("routes" in legacy).toBe(false);
    expect(wranglerEnv("wrangler.jsonc", "production").routes).toBeUndefined();
    expect(api.routes).toBeUndefined();
  });

  it("does not take the Feed runtime binding (Feed stays on legacy)", () => {
    expect(api.services ?? []).toEqual([]);
  });
});
