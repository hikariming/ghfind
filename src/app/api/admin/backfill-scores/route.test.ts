import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backfillCanonicalScoresPage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  backfillCanonicalScoresPage: mocks.backfillCanonicalScoresPage,
}));

import { POST } from "./route";

const originalAdminSecret = process.env.ADMIN_SECRET;
const originalApplySwitch = process.env.BACKFILL_SCORES_APPLY_ENABLED;
const originalPauseSwitch = process.env.BACKFILL_SCORES_PAUSED;

const aggregateResult = {
  dryRun: true,
  processed: 10,
  eligible: 6,
  materialized: 0,
  skipped: 3,
  rejected: 1,
  failed: 0,
  nextCursor: "bfs1.synthetic-page-token",
};

function request(body?: unknown, authorized = true) {
  return new NextRequest("https://example.test/api/admin/backfill-scores", {
    method: "POST",
    headers: authorized
      ? {
          "content-type": "application/json",
          "x-admin-secret": "synthetic-admin-secret",
        }
      : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("canonical score backfill operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_SECRET = "synthetic-admin-secret";
    delete process.env.BACKFILL_SCORES_APPLY_ENABLED;
    delete process.env.BACKFILL_SCORES_PAUSED;
    mocks.backfillCanonicalScoresPage.mockResolvedValue(aggregateResult);
  });

  afterEach(() => {
    if (originalAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = originalAdminSecret;
    if (originalApplySwitch === undefined) {
      delete process.env.BACKFILL_SCORES_APPLY_ENABLED;
    } else {
      process.env.BACKFILL_SCORES_APPLY_ENABLED = originalApplySwitch;
    }
    if (originalPauseSwitch === undefined) {
      delete process.env.BACKFILL_SCORES_PAUSED;
    } else {
      process.env.BACKFILL_SCORES_PAUSED = originalPauseSwitch;
    }
  });

  it("requires the existing admin credential", async () => {
    expect((await POST(request({}, false))).status).toBe(403);

    delete process.env.ADMIN_SECRET;
    expect((await POST(request({}, true))).status).toBe(403);
    expect(mocks.backfillCanonicalScoresPage).not.toHaveBeenCalled();
  });

  it("defaults to a dry-run and only returns aggregate fields", async () => {
    mocks.backfillCanonicalScoresPage.mockResolvedValue({
      ...aggregateResult,
      username: "must-not-leak",
      accounts: ["must-not-leak"],
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.backfillCanonicalScoresPage).toHaveBeenCalledWith({
      apply: false,
      limit: 25,
      cursor: null,
    });
    const payload = await response.json();
    expect(payload).toEqual(aggregateResult);
    expect(JSON.stringify(payload)).not.toMatch(/username|accounts|must-not-leak/i);
  });

  it("requires the independent apply switch before writing", async () => {
    const disabled = await POST(request({ apply: true, limit: 10 }));
    expect(disabled.status).toBe(409);
    await expect(disabled.json()).resolves.toEqual({ error: "apply_disabled" });
    expect(mocks.backfillCanonicalScoresPage).not.toHaveBeenCalled();

    process.env.BACKFILL_SCORES_APPLY_ENABLED = "1";
    mocks.backfillCanonicalScoresPage.mockResolvedValue({
      ...aggregateResult,
      dryRun: false,
      materialized: 6,
    });
    const enabled = await POST(request({ apply: true, limit: 10 }));
    expect(enabled.status).toBe(200);
    expect(mocks.backfillCanonicalScoresPage).toHaveBeenCalledWith({
      apply: true,
      limit: 10,
      cursor: null,
    });
    await expect(enabled.json()).resolves.toMatchObject({ dryRun: false, materialized: 6 });
  });

  it("halts all pages while the operational pause switch is set", async () => {
    process.env.BACKFILL_SCORES_APPLY_ENABLED = "1";
    process.env.BACKFILL_SCORES_PAUSED = "1";
    const response = await POST(request({ apply: true }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "backfill_paused",
      paused: true,
    });
    expect(mocks.backfillCanonicalScoresPage).not.toHaveBeenCalled();
  });

  it("enforces batch bounds and keyset-only pagination", async () => {
    for (const limit of [0, 101, 1.5, "25"]) {
      const response = await POST(request({ limit }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_limit" });
    }
    expect((await POST(request({ offset: 10 }))).status).toBe(400);
    expect((await POST(request({ cursor: " padded " }))).status).toBe(400);
    expect(mocks.backfillCanonicalScoresPage).not.toHaveBeenCalled();

    mocks.backfillCanonicalScoresPage.mockResolvedValue({
      ...aggregateResult,
      nextCursor: null,
    });
    const first = await POST(request({ limit: 1, cursor: "bfs1.page-a" }));
    const last = await POST(request({ limit: 100, cursor: "bfs1.page-b" }));
    expect(first.status).toBe(200);
    expect(last.status).toBe(200);
    expect(mocks.backfillCanonicalScoresPage).toHaveBeenNthCalledWith(1, {
      apply: false,
      limit: 1,
      cursor: "bfs1.page-a",
    });
    expect(mocks.backfillCanonicalScoresPage).toHaveBeenNthCalledWith(2, {
      apply: false,
      limit: 100,
      cursor: "bfs1.page-b",
    });
  });
});
