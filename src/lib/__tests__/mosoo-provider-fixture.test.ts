import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProviders } from "../../../scripts/feed-e2e/provider-fixtures.mjs";

const endpoint = "https://feed-e2e-provider.invalid/api/v1/agents/local-e2e-agent/threads";
const input = {
  type: "user.message",
  content: [{ type: "text", text: "analysis_id: analysis-1\nrepository_url: https://github.com/owner/useful-tool\n" }],
};
const create = (body: unknown, idempotencyKey = "fixture-analysis-1") => fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected real transport in provider fixture test."); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("complete local E2E Mosoo transport contract", () => {
  it("accepts userId and correlates artifacts through the analysis prompt", async () => {
    const counts = installProviders();
    const response = await create({ userId: "ghfind-feed-staging", input });
    expect(response.status).toBe(200);
    const created = await response.json();
    expect(created.thread).toMatchObject({ id: "analysis-1", userId: "ghfind-feed-staging", kind: "cattle" });
    expect(created.thread).not.toHaveProperty("client_external_ref");
    const snapshot = await fetch("https://feed-e2e-provider.invalid/api/v1/threads/analysis-1");
    expect((await snapshot.json()).thread.userId).toBe("ghfind-feed-staging");
    const files = await fetch("https://feed-e2e-provider.invalid/api/v1/threads/analysis-1/files");
    expect((await files.json()).files.map((file: { name: string }) => file.name).sort()).toEqual([
      "project-analysis-analysis-1.json", "project-report-analysis-1.md", "runtime-evidence-analysis-1.json",
    ]);
    expect(counts.assessmentCreate).toBe(1);
    expect(counts.unexpectedExternal).toBe(0);
  });

  it.each([
    { input, client_external_ref: "analysis-1" },
    { input, userId: "ghfind", client_external_ref: "analysis-1" },
    { input },
    { input, userId: "" },
    { input, userId: " " },
    { input, userId: 42 },
    { input, userId: "x".repeat(256) },
    { input, userId: "ghfind", provider: "unauthorized" },
    { input: { ...input, extra: true }, userId: "ghfind" },
    { input: { ...input, content: [{ ...input.content[0], extra: true }] }, userId: "ghfind" },
    null,
  ])("rejects an invalid API body without recording an assessment (%#)", async (body) => {
    const counts = installProviders();
    const response = await create(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(counts.assessmentCreate).toBe(0);
  });

  it("requires the application's stable idempotency key", async () => {
    const counts = installProviders();
    expect((await create({ userId: "ghfind", input }, "")).status).toBe(400);
    expect(counts.assessmentCreate).toBe(0);
  });
});
