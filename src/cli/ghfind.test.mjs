import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./ghfind.mjs";

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const originalExit = process.exit;
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GITHUB_ROAST_API_KEY;
const originalHost = process.env.GITHUB_ROAST_HOST;
const originalGhfindApiKey = process.env.GHFIND_API_KEY;
const originalGhfindHost = process.env.GHFIND_HOST;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function metaHeader(meta) {
  return Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
}

const scanPayload = {
  metrics: { username: "DemoDev" },
  scoring: {
    final_score: 68,
    tier: "NPC",
    tier_label: "普通账号 · 特征平庸存疑",
    sub_scores: { contribution_quality: 20 },
    red_flags: [],
  },
  cached: false,
};

describe("ghfind CLI", () => {
  let stdout = "";

  beforeEach(() => {
    stdout = "";
    process.stdout.write = vi.fn((chunk) => {
      stdout += String(chunk);
      return true;
    });
    process.stderr.write = vi.fn((_chunk) => {
      return true;
    });
    process.exit = vi.fn((code) => {
      throw new Error(`exit:${code}`);
    });
    delete process.env.GITHUB_ROAST_API_KEY;
    delete process.env.GITHUB_ROAST_HOST;
    delete process.env.GHFIND_API_KEY;
    delete process.env.GHFIND_HOST;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GITHUB_ROAST_API_KEY;
    else process.env.GITHUB_ROAST_API_KEY = originalApiKey;
    if (originalHost === undefined) delete process.env.GITHUB_ROAST_HOST;
    else process.env.GITHUB_ROAST_HOST = originalHost;
    if (originalGhfindApiKey === undefined) delete process.env.GHFIND_API_KEY;
    else process.env.GHFIND_API_KEY = originalGhfindApiKey;
    if (originalGhfindHost === undefined) delete process.env.GHFIND_HOST;
    else process.env.GHFIND_HOST = originalGhfindHost;
    vi.restoreAllMocks();
  });

  it("lists agent-callable commands as JSON", async () => {
    await run(["commands", "--json"]);

    const body = JSON.parse(stdout);
    expect(body.default_host).toBe("https://ghfind.com");
    expect(body.commands.map((cmd) => cmd.name)).toContain("roast");
  });

  it("shows multi-word command metadata", async () => {
    await run(["commands", "show", "update", "check", "--json"]);

    const body = JSON.parse(stdout);
    expect(body.name).toBe("update check");
    expect(body.api).toContain("GET https://api.github.com/repos/hikariming/ghfind/releases/latest");
  });

  it("calls /api/scan for score without importing local scoring logic", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(scanPayload);
    });

    await run(["score", "DemoDev", "--api-key", "secret", "-o", "json"]);

    const body = JSON.parse(stdout);
    expect(body.final_score).toBe(68);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ghfind.com/api/scan");
    expect(calls[0].init.headers.authorization).toBe("Bearer secret");
  });

  it("prefers ghfind env vars for host and machine auth", async () => {
    process.env.GHFIND_HOST = "https://cli.example.test";
    process.env.GHFIND_API_KEY = "ghfind-secret";
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(scanPayload);
    });

    await run(["score", "DemoDev", "-o", "json"]);

    expect(calls[0].url).toBe("https://cli.example.test/api/scan");
    expect(calls[0].init.headers.authorization).toBe("Bearer ghfind-secret");
  });

  it("calls /api/scan then /api/roast for roast JSON output", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith("/api/scan")) return jsonResponse(scanPayload);
      return new Response("## Demo\nReport", {
        headers: {
          "x-roast-meta": metaHeader({
            final_score: 71,
            tier: "人上人",
            tier_label: "优质贡献者 · 值得信任",
            delta: 3,
            tags: { zh: ["测试"], en: ["test"] },
            roast_line: { zh: "中文", en: "English" },
          }),
        },
      });
    });

    await run(["roast", "DemoDev", "--lang", "zh", "-o", "json"]);

    const body = JSON.parse(stdout);
    expect(body.username).toBe("DemoDev");
    expect(body.final_score).toBe(71);
    expect(body.report).toBe("## Demo\nReport");
    expect(calls.map((call) => call.url)).toEqual([
      "https://ghfind.com/api/scan",
      "https://ghfind.com/api/roast",
    ]);
  });

  it("calls discovery APIs without touching scan or roast", async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ entries: [], cached: true, view: "score", window: "7d" });
    });

    await run(["leaderboard", "--view", "score", "--window", "7d", "-o", "json"]);

    expect(JSON.parse(stdout).view).toBe("score");
    expect(calls.map((call) => call.url)).toEqual([
      "https://ghfind.com/api/leaderboard?view=score&window=7d",
    ]);
  });

  it("checks the latest ghfind release", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        tag_name: "v99.0.0",
        html_url: "https://example.test/releases/v99.0.0",
      }),
    );

    await run(["update", "check", "--release-url", "https://example.test/latest", "-o", "json"]);

    const body = JSON.parse(stdout);
    expect(body.name).toBe("ghfind");
    expect(body.latest_version).toBe("v99.0.0");
    expect(body.update_available).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://example.test/latest",
      expect.objectContaining({ headers: expect.objectContaining({ "user-agent": "ghfind-cli" }) }),
    );
  });
});
