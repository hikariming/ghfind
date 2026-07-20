import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicScanJobVersionSummary: vi.fn(),
  quarantineObsoletePublicScanJobs: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getPublicScanJobVersionSummary: mocks.getPublicScanJobVersionSummary,
  quarantineObsoletePublicScanJobs: mocks.quarantineObsoletePublicScanJobs,
}));

import { GET, POST } from "./route";

const originalAdminSecret = process.env.ADMIN_SECRET;
const originalQuarantineSwitch = process.env.PUBLIC_SCAN_QUARANTINE_ENABLED;

function request(method: "GET" | "POST", body?: unknown, authorized = true) {
  return new NextRequest("https://example.test/api/admin/public-scan-jobs", {
    method,
    headers: authorized
      ? { "x-admin-secret": "synthetic-admin-secret", "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("public scan job release operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_SECRET = "synthetic-admin-secret";
    delete process.env.PUBLIC_SCAN_QUARANTINE_ENABLED;
    mocks.getPublicScanJobVersionSummary.mockResolvedValue([]);
    mocks.quarantineObsoletePublicScanJobs.mockResolvedValue({
      dryRun: true,
      selected: 2,
      quarantined: 0,
      remainingActive: 2,
      deferredActive: 0,
    });
  });

  afterEach(() => {
    if (originalAdminSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = originalAdminSecret;
    if (originalQuarantineSwitch === undefined) {
      delete process.env.PUBLIC_SCAN_QUARANTINE_ENABLED;
    } else {
      process.env.PUBLIC_SCAN_QUARANTINE_ENABLED = originalQuarantineSwitch;
    }
  });

  it("requires the operator credential for inventory and quarantine", async () => {
    expect((await GET(request("GET", undefined, false))).status).toBe(403);
    expect((await POST(request("POST", {}, false))).status).toBe(403);
    expect(mocks.getPublicScanJobVersionSummary).not.toHaveBeenCalled();
    expect(mocks.quarantineObsoletePublicScanJobs).not.toHaveBeenCalled();
  });

  it("returns aggregate inventory without mutation", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      canonicalCollectionVersion: "v4",
      versions: [],
    });
  });

  it("defaults to a bounded dry-run", async () => {
    const response = await POST(request("POST", { limit: 1000 }));
    expect(response.status).toBe(200);
    expect(mocks.quarantineObsoletePublicScanJobs).toHaveBeenCalledWith({
      canonicalCollectionVersion: "v4",
      apply: false,
      limit: 100,
    });
  });

  it("requires the deployment switch before applying a batch", async () => {
    const disabled = await POST(request("POST", { apply: true, limit: 10 }));
    expect(disabled.status).toBe(409);
    expect(mocks.quarantineObsoletePublicScanJobs).not.toHaveBeenCalled();

    process.env.PUBLIC_SCAN_QUARANTINE_ENABLED = "1";
    mocks.quarantineObsoletePublicScanJobs.mockResolvedValue({
      dryRun: false,
      selected: 2,
      quarantined: 2,
      remainingActive: 0,
      deferredActive: 0,
    });
    const enabled = await POST(request("POST", { apply: true, limit: 10 }));
    expect(enabled.status).toBe(200);
    expect(mocks.quarantineObsoletePublicScanJobs).toHaveBeenCalledWith({
      canonicalCollectionVersion: "v4",
      apply: true,
      limit: 10,
    });
  });

  it("treats a null JSON body as a dry-run", async () => {
    const response = await POST(request("POST", null));
    expect(response.status).toBe(200);
    expect(mocks.quarantineObsoletePublicScanJobs).toHaveBeenCalledWith(
      expect.objectContaining({ apply: false, limit: 25 }),
    );
  });
});
