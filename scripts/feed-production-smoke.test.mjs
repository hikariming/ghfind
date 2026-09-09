import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTOR_ID, LIMITS, RUNTIME_ORIGIN, dryPlan, main, parseOptions, runSmoke } from "./feed-production-smoke.mjs";

const SHA = "a".repeat(40);
const IMAGE = `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${"b".repeat(64)}`;
const ENV = { FEED_RUNTIME_ADMIN_SECRET: "fixture-admin-secret-".repeat(3), FEED_GATEWAY_SECRET: "fixture-gateway-secret-".repeat(3) };
function args(mode = "all", runtime = "baseline") { return ["--mode", mode, "--runtime-mode", runtime, "--release-sha", SHA, "--image", IMAGE, "--writer-epoch", "3", "--profile", "cf_d1_r2", "--output", "/tmp/unused-service-smoke.json"]; }
const configuration = () => parseOptions(args());
const identity = { id: ACTOR_ID, login: "fixture-account", avatar_url: `https://avatars.githubusercontent.com/u/${ACTOR_ID}?v=4`, type: "User" };
const prefs = () => ({ profileVersion: 7, taxonomyVersion: 1, preferences: [{ tagId: "tag-a", source: "explicit", value: 1, strength: 1, taxonomyVersion: 1 }] });
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
function ready(mode = "baseline") {
  return { ready: true, service: "feed-runtime", version: SHA, contractVersion: "1", configuredImage: IMAGE, mode, workerVersionId: "11111111-1111-4111-8111-111111111111", containers: ["api-0", "api-1", "executor-0"].map(target => ({ target, ready: true, version: SHA, contractVersion: "1", storageWriterVersion: 2, storeProfile: "cf_d1_r2", writerEpoch: 3, mode, service: target === "executor-0" ? "feed-worker" : "feed-api" })) };
}
function fixture(overrides = {}) {
  const requests = [];
  const fetcher = vi.fn(async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    requests.push({ url, init });
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
    expect(headers.get("cookie")).toBeNull();
    if (overrides.request) {
      const response = await overrides.request(url, init, requests.length);
      if (response) return response;
    }
    if (url.origin === "https://api.github.com") {
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-feed-gateway")).toBeNull();
      expect(url.pathname).toBe(`/user/${ACTOR_ID}`);
      return json(overrides.identity ?? identity);
    }
    expect(url.origin).toBe(RUNTIME_ORIGIN);
    if (url.pathname === "/healthz") {
      expect(headers.get("authorization")).toBe(`Bearer ${ENV.FEED_RUNTIME_ADMIN_SECRET}`);
      return json({ healthy: true, service: "feed-runtime" });
    }
    if (url.pathname === "/readyz") return headers.has("authorization") ? json(overrides.readiness ?? ready()) : json({ error: "unauthorized" }, 401);
    const token = headers.get("x-feed-gateway");
    if (!token || token === "forged.invalid.signature") return json({ error: "unauthorized" }, 401);
    expect(headers.get("authorization")).toBeNull();
    const [payload, signature] = token.split(".");
    expect(signature).toBe(createHmac("sha256", ENV.FEED_GATEWAY_SECRET).update(`feed-gateway-v1\n${payload}`).digest("base64url"));
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({ githubId: ACTOR_ID, login: identity.login, avatarUrl: identity.avatar_url, version: 1, audience: "feed-api", method: "GET", target: url.pathname + url.search });
    expect(claims.expiresAt - claims.issuedAt).toBe(30_000);
    if (url.pathname === "/api/feed/preferences") return json(overrides.preferences?.(requests.length) ?? prefs());
    if (url.pathname === "/api/feed/tags") return json({ taxonomyVersion: 1, tags: [{ id: "tag-a" }] });
    if (url.pathname === "/api/feed/projects") {
      if (overrides.empty) return json({ items: [], nextCursor: null });
      const next = url.searchParams.has("cursor");
      return json({ items: [{ project: { repoKey: next ? "other/repo" : "fixture/repo" }, impressionToken: "do-not-retain-secret-token" }], nextCursor: next ? null : "cursor/should-not-be-in-report" });
    }
    throw new Error("unregistered fixture operation");
  });
  return { fetcher, requests };
}
afterEach(() => vi.useRealTimers());

describe("production service-contract smoke", () => {
  it("defaults to a dry plan without reading secrets, contacting services or writing output", async () => {
    const fetcher = vi.fn(() => { throw new Error("network forbidden"); });
    const stdout = vi.fn();
    expect(await main(args(), { env: {}, fetcher, stdout })).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ runtimeOrigin: RUNTIME_ORIGIN, limits: { httpRequests: 20, events: 0, mutatingHTTPMethods: 0 } });
  });

  it("rejects ambiguous targets, mutable versions and unsafe mode combinations", () => {
    for (const added of [["--runtime-origin", "https://evil.test"], ["--release-sha", SHA], ["--events", "5"]]) expect(() => parseOptions([...args(), ...added])).toThrow();
    for (const [flag, value] of [["--mode", "internal"], ["--release-sha", "main"], ["--image", "ghfind:latest"], ["--writer-epoch", "0"], ["--writer-epoch", "3e0"], ["--profile", "postgres"]]) {
      const input = args(); input[input.indexOf(flag) + 1] = value;
      expect(() => parseOptions(input)).toThrow();
    }
    expect(() => parseOptions(args("all", "off"))).toThrow("invalid_mode");
    expect(parseOptions(args("paused", "off")).runtimeMode).toBe("off");
    expect(parseOptions(args("paused", "baseline")).runtimeMode).toBe("baseline");
  });

  it("checks paused candidate infrastructure and authentication without a signed user request", async () => {
    const f = fixture({ readiness: ready("off") });
    const result = await runSmoke(parseOptions(args("paused", "off")), { env: { FEED_RUNTIME_ADMIN_SECRET: ENV.FEED_RUNTIME_ADMIN_SECRET }, fetcher: f.fetcher });
    expect(result.status).toBe("passed");
    expect(result.httpRequests).toBe(5);
    expect(result.journey).toBe("not_requested");
    expect(result.webGatewayModeObserved).toBe(false);
    expect(f.requests.every(r => r.url.origin === RUNTIME_ORIGIN)).toBe(true);
  });

  it("executes only bounded GETs with verified service identity and no retained token or preferences", async () => {
    const f = fixture();
    const result = await runSmoke(configuration(), { env: ENV, fetcher: f.fetcher });
    expect(result.status).toBe("passed");
    expect(result.journey).toBe("service_contract_passed");
    expect(result.httpRequests).toBe(12);
    expect(result.httpRequests).toBeLessThanOrEqual(LIMITS.httpRequests);
    expect(result.eventsSent).toBe(0);
    expect(result.cursorRepeatVerified).toBe(true);
    expect(result.profileReadback).toEqual({ profileVersion: 7, taxonomyVersion: 1, preferenceCount: 1, unchanged: true });
    const encoded = JSON.stringify(result);
    for (const sensitive of [ENV.FEED_GATEWAY_SECRET, ENV.FEED_RUNTIME_ADMIN_SECRET, "do-not-retain-secret-token", "cursor/should-not-be-in-report", "tag-a", "fixture-account", "fixture/repo"]) expect(encoded).not.toContain(sensitive);
    expect(f.requests.every(r => r.init.method === "GET")).toBe(true);
  });

  it("fails with no candidates instead of claiming a completed Feed journey", async () => {
    const f = fixture({ empty: true });
    const result = await runSmoke(configuration(), { env: ENV, fetcher: f.fetcher });
    expect(result).toMatchObject({ status: "incomplete", failureCode: "feed_candidates_empty", journey: "incomplete", eventsSent: 0, candidatesObserved: 0 });
    expect(result.httpRequests).toBe(9);
  });

  it("requires matching actual runtime and all three Container identities before service-user writes", async () => {
    for (const mutate of [r => { r.version = "c".repeat(40); }, r => { r.mode = "off"; }, r => { r.configuredImage = IMAGE.replace(/b/g, "c"); }, r => { r.containers[0].mode = "off"; }, r => { r.containers[1].writerEpoch = 2; }, r => { r.containers[2].storageWriterVersion = 1; }, r => { r.containers[1].target = "api-0"; }, r => { r.containers[2].storeProfile = "postgres"; }]) {
      const data = ready(); mutate(data);
      const f = fixture({ readiness: data });
      const result = await runSmoke(configuration(), { env: ENV, fetcher: f.fetcher });
      expect(result.status).toBe("incomplete");
      expect(result.httpRequests).toBe(2);
      expect(result.serviceIdentityVerified).toBeUndefined();
    }
  });

  it("stops before Feed profile requests on wrong public GitHub identity", async () => {
    const f = fixture({ identity: { ...identity, id: 42 } });
    const result = await runSmoke(configuration(), { env: ENV, fetcher: f.fetcher });
    expect(result.failureCode).toBe("github_identity_mismatch");
    expect(result.httpRequests).toBe(6);
  });

  it("reports a concurrent profile change without restoring or overwriting it", async () => {
    const f = fixture({ preferences: count => ({ ...prefs(), profileVersion: count > 7 ? 8 : 7 }) });
    const result = await runSmoke(configuration(), { env: ENV, fetcher: f.fetcher });
    expect(result.failureCode).toBe("profile_changed_during_smoke");
    expect(f.requests.every(r => r.init.method === "GET")).toBe(true);
  });

  it("bounds response bodies and never includes a reflected upstream error in the report", async () => {
    const f = fixture({ request: () => new Response("private-secret-raw".repeat(5000), { headers: { "content-type": "application/json", "cache-control": "no-store" } }) });
    const result = await runSmoke(configuration(), { env: ENV, fetcher: f.fetcher });
    expect(result.failureCode).toBe("response_too_large");
    expect(JSON.stringify(result)).not.toContain("private-secret-raw");
    expect(result.httpRequests).toBe(1);
  });

  it("keeps the body read inside the request deadline even when cancellation stalls", async () => {
    vi.useFakeTimers();
    const f = fixture({ request: () => new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }) });
    const pending = runSmoke(configuration(), { env: ENV, fetcher: f.fetcher });
    await vi.advanceTimersByTimeAsync(LIMITS.requestMs + 1);
    const result = await pending;
    expect(result.failureCode).toBe("request_deadline");
    expect(result.httpRequests).toBe(1);
  });

  it("does not contact any endpoint without dedicated secrets or when the total budget is exhausted", async () => {
    const f = fixture();
    expect((await runSmoke(configuration(), { env: {}, fetcher: f.fetcher })).failureCode).toBe("runtime_admin_secret_required");
    expect((await runSmoke(configuration(), { env: { ...ENV, FEED_GATEWAY_SECRET: ENV.FEED_RUNTIME_ADMIN_SECRET }, fetcher: f.fetcher })).failureCode).toBe("independent_gateway_secret_required");
    let clock = 0;
    expect((await runSmoke(configuration(), { env: ENV, fetcher: f.fetcher, now: () => { clock += LIMITS.totalMs; return clock; } })).failureCode).toBe("smoke_budget_exhausted");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("creates the incomplete report before network work and preserves failure with exit1", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ghfind-smoke-unit-"));
    try {
      const output = join(directory, "report.json");
      const input = args(); input[input.indexOf("--output") + 1] = output; input.push("--execute");
      const f = fixture({ empty: true, request: (_url, _init, count) => { if (count === 1) expect(JSON.parse(readFileSync(output)).status).toBe("incomplete"); } });
      expect(await main(input, { env: ENV, fetcher: f.fetcher, stdout: () => {} })).toBe(1);
      expect(JSON.parse(readFileSync(output))).toMatchObject({ status: "incomplete", failureCode: "feed_candidates_empty" });
      await expect(main(input, { env: ENV, fetcher: f.fetcher, stdout: () => {} })).rejects.toThrow();
      expect(dryPlan(configuration()).scope).toContain("not real OAuth");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
