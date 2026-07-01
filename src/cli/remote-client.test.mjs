import { describe, expect, it } from "vitest";
import {
  getDevelopers,
  getLeaderboard,
  getStats,
  parseRoastResponse,
  roastAccount,
  scanAccount,
} from "./remote-client.mjs";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function metaHeader(meta) {
  return Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
}

describe("remote CLI client", () => {
  it("calls the same scan API used by the website", async () => {
    const calls = [];
    const result = await scanAccount({
      username: "DemoDev",
      host: "https://ghfind.com/",
      apiKey: "secret",
      turnstileToken: "turnstile",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ metrics: { username: "DemoDev" }, cached: false });
      },
    });

    expect(result.metrics.username).toBe("DemoDev");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ghfind.com/api/scan");
    expect(calls[0].init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      username: "DemoDev",
      turnstileToken: "turnstile",
    });
  });

  it("calls the website roast API with the scan payload", async () => {
    const calls = [];
    const scan = { metrics: { username: "DemoDev" }, scoring: { final_score: 70 } };
    const result = await roastAccount({
      scan,
      lang: "en",
      host: "https://ghfind.com",
      apiKey: "secret",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response("## Demo\nReport", {
          headers: { "x-roast-meta": metaHeader({ final_score: 70 }) },
        });
      },
    });

    expect(result.meta.final_score).toBe(70);
    expect(result.report).toBe("## Demo\nReport");
    expect(calls[0].url).toBe("https://ghfind.com/api/roast");
    expect(JSON.parse(calls[0].init.body)).toEqual({ scan, lang: "en" });
  });

  it("parses streamed roast frames into meta and markdown", async () => {
    const meta = { final_score: 75.4, tier: "人上人" };
    const response = new Response(
      `\x1fTCalibrating\n\x1fM${metaHeader(meta)}\n## Demo\nReport\n`,
    );

    await expect(parseRoastResponse(response)).resolves.toEqual({
      meta,
      report: "## Demo\nReport",
      progress: ["Calibrating"],
    });
  });

  it("calls website discovery APIs with GET", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    };

    await getStats({ host: "https://ghfind.com", fetchImpl });
    await getLeaderboard({ host: "https://ghfind.com", fetchImpl, view: "score", window: "7d" });
    await getDevelopers({ host: "https://ghfind.com", fetchImpl, type: "language", value: "Go" });

    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ["https://ghfind.com/api/stats", "GET"],
      ["https://ghfind.com/api/leaderboard?view=score&window=7d", "GET"],
      ["https://ghfind.com/api/developers?type=language&value=Go", "GET"],
    ]);
  });
});
