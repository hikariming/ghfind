import { afterEach, describe, expect, it, vi } from "vitest";

const d1 = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], binds: [] as unknown[][], fail: false }));
vi.mock("@/lib/d1-client", () => ({
  getD1Binding: () => ({
    prepare: () => ({
      bind(...values: unknown[]) {
        d1.binds.push(values);
        return this;
      },
      all: async () => {
        if (d1.fail) throw new Error("boom");
        return { results: d1.rows, meta: {} };
      },
    }),
  }),
}));

import { GET } from "../route";

const visit = (id: string) => GET(new Request(`https://ghfind.test/api/sponsors/${id}/visit`), { params: Promise.resolve({ id }) });

afterEach(() => {
  d1.rows = [];
  d1.binds = [];
  d1.fail = false;
});

describe("GET /api/sponsors/:id/visit", () => {
  it("302s to the stored sponsor URL, referral params intact", async () => {
    d1.rows = [{ sponsor_url: "https://sponsor.example/?aff=TEST" }];
    const res = await visit("sponsor-example");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://sponsor.example/?aff=TEST");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(d1.binds[0][0]).toBe("sponsor-example");
  });

  it("404s for unknown, expired or anonymous sponsorships", async () => {
    const res = await visit("missing");
    expect(res.status).toBe(404);
  });

  it("never redirects to a non-http URL", async () => {
    d1.rows = [{ sponsor_url: "javascript:alert(1)" }];
    expect((await visit("sponsor-example")).status).toBe(404);
  });

  it("rejects malformed ids before touching the database", async () => {
    const res = await visit("../etc");
    expect(res.status).toBe(400);
    expect(d1.binds).toHaveLength(0);
  });

  it("500s when the lookup fails", async () => {
    d1.fail = true;
    expect((await visit("sponsor-example")).status).toBe(500);
  });
});
