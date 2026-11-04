import { afterEach, describe, expect, it, vi } from "vitest";
import { byoKey, parseArgs, run } from "./cli.js";

/** Capture everything written to stdout while `fn` runs. */
async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("collects positionals and boolean flags", () => {
    const { positional, flags } = parseArgs(["scan", "torvalds", "--json", "--verify"]);
    expect(positional).toEqual(["scan", "torvalds"]);
    expect(flags.json).toBe(true);
    expect(flags.verify).toBe(true);
  });

  it("reads value flags", () => {
    const { flags } = parseArgs([
      "roast",
      "x",
      "--lang",
      "en",
      "-o",
      "markdown",
      "--byo-model",
      "gpt-4o",
    ]);
    expect(flags.lang).toBe("en");
    expect(flags.output).toBe("markdown");
    expect(flags.byoModel).toBe("gpt-4o");
  });

  it("treats --md as an alias for --markdown", () => {
    expect(parseArgs(["badge", "x", "--md"]).flags.markdown).toBe(true);
  });
});

describe("byoKey", () => {
  it("returns a key only when all three parts are present", () => {
    expect(
      byoKey({ byoBaseUrl: "https://api.openai.com/v1", byoApiKey: "k", byoModel: "gpt-4o" }),
    ).toEqual({ baseURL: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4o" });
  });

  it("is undefined when nothing is set", () => {
    // guard against env leakage from the host machine
    const saved = {
      b: process.env.GHFIND_BYO_BASE_URL,
      k: process.env.GHFIND_BYO_API_KEY,
      m: process.env.GHFIND_BYO_MODEL,
    };
    delete process.env.GHFIND_BYO_BASE_URL;
    delete process.env.GHFIND_BYO_API_KEY;
    delete process.env.GHFIND_BYO_MODEL;
    try {
      expect(byoKey({})).toBeUndefined();
    } finally {
      if (saved.b) process.env.GHFIND_BYO_BASE_URL = saved.b;
      if (saved.k) process.env.GHFIND_BYO_API_KEY = saved.k;
      if (saved.m) process.env.GHFIND_BYO_MODEL = saved.m;
    }
  });
});

describe("offline commands", () => {
  it("prints the version", async () => {
    const out = await captureStdout(() => run(["version"]));
    expect(out.trim()).toBe("ghfind 0.2.0");
  });

  it("badge --markdown emits a README-ready snippet linking to the profile", async () => {
    const out = await captureStdout(() =>
      run(["badge", "torvalds", "--markdown", "--host", "https://ghfind.com"]),
    );
    expect(out.trim()).toBe(
      "[![ghfind score](https://ghfind.com/api/badge/torvalds)](https://ghfind.com/u/torvalds)",
    );
  });

  it("card prints the OG card URL", async () => {
    const out = await captureStdout(() => run(["card", "torvalds", "--host", "https://ghfind.com"]));
    expect(out.trim()).toBe("https://ghfind.com/api/card/torvalds");
  });

  it("commands lists capabilities with getScore first", async () => {
    const out = await captureStdout(() => run(["commands"]));
    expect(out.split("\n")[0]).toContain("getScore");
  });

  it("help mentions verify and byo", async () => {
    const out = await captureStdout(() => run(["--help"]));
    expect(out).toContain("--verify");
    expect(out).toContain("verify <scan.json|->");
    expect(out).not.toContain("--local");
    expect(out).toContain("--byo-base-url");
  });

  it("--local explains that crawling moved to the service", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(run(["score", "torvalds", "--local"])).rejects.toThrow("exit 1");
    expect(String(stderr.mock.calls[0][0])).toContain("--local was removed");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("verify recomputes a saved scan and exits 3 on mismatch", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { scoreMetrics } = await import("./local.js");
    const fixture = await import("@ghfind/scoring/fixtures/newcomer-score-fixtures.json");
    const metrics = fixture.default.metrics as unknown as Parameters<typeof scoreMetrics>[0];
    const scoring = scoreMetrics(metrics);
    const dir = mkdtempSync(join(tmpdir(), "ghfind-verify-"));
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    writeFileSync(good, JSON.stringify({ metrics, scoring }));
    writeFileSync(bad, JSON.stringify({ metrics, scoring: { ...scoring, final_score: scoring.final_score + 5 } }));

    const ok = await captureStdout(() => run(["verify", good, "--json"]));
    expect(JSON.parse(ok)).toMatchObject({ username: metrics.username, verified: true, differences: [] });

    try {
      const printed = await captureStdout(() => run(["verify", bad]));
      expect(printed).toContain("NOT verified");
      expect(printed).toContain("- final_score: server");
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = undefined;
    }
  });

  it("update check reports available releases", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: "v0.3.0", html_url: "https://example.test/v0.3.0" }),
      })),
    );

    const out = await captureStdout(() => run(["update", "check", "--release-url", "https://example.test/latest", "-o", "json"]));
    const payload = JSON.parse(out);

    expect(payload.name).toBe("ghfind");
    expect(payload.update_available).toBe(true);
    expect(payload.latest_version).toBe("v0.3.0");
  });

  it("update npm dry-run reports scoped package command", async () => {
    const out = await captureStdout(() => run(["update", "npm", "--dry-run", "-o", "json"]));
    const payload = JSON.parse(out);

    expect(payload.method).toBe("npm");
    expect(payload.status).toBe("dry_run");
    expect(payload.command).toEqual(["npm", "install", "-g", "@hikariming/ghfind@latest"]);
  });
});
