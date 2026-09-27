import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GhFindError } from "./client.js";
import { collectAndScore, scoreDeveloper } from "./local.js";

const real = join(import.meta.dirname, "../../../src/lib/devscore/engine/__tests__/fixtures/real");

describe("ghfind/local", () => {
  it("scores a devscore v15 developer exactly like the devscore engine", () => {
    const expected = JSON.parse(readFileSync(join(real, "expected.json"), "utf8"))["knuknY.json"];
    const r = scoreDeveloper(JSON.parse(readFileSync(join(real, "knuknY.json"), "utf8")));
    expect(r.devscore.v3.tier).toBe(expected.v3.tier);
    expect(Math.abs(r.devscore.v3.score - expected.v3.score)).toBeLessThanOrEqual(1e-9);
    // The published v11 final score is the v3 score truncated to two decimals.
    expect(r.scoring.final_score).toBe(Math.floor(expected.v3.score * 100) / 100);
    expect(r.scoring.risk_assessment?.version).toBe("v11");
  });

  it("requires a GitHub token", async () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      await expect(collectAndScore("torvalds")).rejects.toMatchObject({ code: "github_token_required" });
    } finally {
      if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
    }
  });

  it("collects with the given token and maps a missing login to account_not_found", async () => {
    const auth: (string | null)[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ data: { user: null } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const error = await collectAndScore("ghost", { token: "tok-a", fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhFindError);
    expect(error).toMatchObject({ status: 404, code: "account_not_found" });
    expect(auth).toEqual(["Bearer tok-a"]);
  });
});
