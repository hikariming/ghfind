import { afterEach, describe, expect, it, vi } from "vitest";

const d1 = vi.hoisted(() => ({
  statements: [] as { sql: string; binds: unknown[] }[],
  batches: 0,
  fail: false,
  missing: false,
}));
vi.mock("@/lib/d1-client", () => ({
  getD1Binding: () =>
    d1.missing
      ? null
      : {
          prepare: (sql: string) => ({
            bind(...binds: unknown[]) {
              const statement = { sql, binds };
              d1.statements.push(statement);
              return statement;
            },
          }),
          batch: async () => {
            d1.batches += 1;
            if (d1.fail) throw new Error("boom");
            return [];
          },
        },
}));

import { POST } from "../route";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36";

const send = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("https://ghfind.test/api/sponsors/pulse", {
      method: "POST",
      headers: { "content-type": "text/plain", "user-agent": BROWSER_UA, origin: "https://ghfind.test", "sec-fetch-site": "same-origin", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

afterEach(() => {
  d1.statements = [];
  d1.batches = 0;
  d1.fail = false;
  d1.missing = false;
  vi.useRealTimers();
});

describe("POST /api/sponsors/pulse", () => {
  it("upserts one counter row per slot, keyed to the Beijing day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 5, 16, 30));
    const res = await send({
      e: [
        ["impression", "sponsor|seed-sponsor-lobehub|top_strip"],
        ["click", "sponsor|seed-sponsor-lobehub|top_strip"],
        ["click", "job|megatron-product-manager|home_hiring"],
      ],
    });
    expect(res.status).toBe(204);
    expect(d1.batches).toBe(1);
    expect(d1.statements).toHaveLength(2);

    const [sponsor, job] = d1.statements;
    expect(sponsor.sql).toContain("FROM sponsorships WHERE id = ?");
    expect(sponsor.sql).toContain("COALESCE(advertiser_id, id)");
    expect(sponsor.sql).toContain("ON CONFLICT(day, ad_kind, ad_id, placement) DO UPDATE");
    expect(sponsor.binds).toEqual(["2026-11-06", "sponsor", "seed-sponsor-lobehub", "top_strip", 1, 1, Date.UTC(2026, 10, 5, 16, 30), "seed-sponsor-lobehub"]);
    expect(job.sql).toContain("SELECT ?, ?, ?, ?, company_id, ?, ?, ? FROM jobs WHERE id = ?");
    expect(job.binds.slice(0, 6)).toEqual(["2026-11-06", "job", "megatron-product-manager", "home_hiring", 0, 1]);
  });

  it("writes static credits with their fixed advertiser key", async () => {
    expect((await send({ e: [["impression", "static|minicpm|model_credit"]] })).status).toBe(204);
    expect(d1.statements[0].sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    expect(d1.statements[0].binds.slice(1, 7)).toEqual(["static", "minicpm", "model_credit", "minicpm", 1, 0]);
  });

  it("accepts a same-origin beacon whose Origin differs from the proxied request URL", async () => {
    expect((await send({ e: [["click", "job|a|home_hiring"]] }, { origin: "http://127.0.0.1:4390" })).status).toBe(204);
  });

  it("rejects cross-site requests", async () => {
    expect((await send({ e: [["click", "job|a|home_hiring"]] }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(d1.batches).toBe(0);
  });

  it("drops crawler traffic without writing", async () => {
    const res = await send({ e: [["click", "job|a|home_hiring"]] }, { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
    expect(res.status).toBe(204);
    expect(d1.batches).toBe(0);
  });

  it("400s on malformed payloads before touching the database", async () => {
    expect((await send("not json")).status).toBe(400);
    expect((await send({ e: [["click", "sponsor|x|nowhere"]] })).status).toBe(400);
    expect(d1.batches).toBe(0);
  });

  it("413s on oversized bodies", async () => {
    expect((await send("x".repeat(9000))).status).toBe(413);
  });

  it("503s without a D1 binding and 500s when the write fails", async () => {
    d1.missing = true;
    expect((await send({ e: [["click", "job|a|home_hiring"]] })).status).toBe(503);
    d1.missing = false;
    d1.fail = true;
    expect((await send({ e: [["click", "job|a|home_hiring"]] })).status).toBe(500);
  });
});
