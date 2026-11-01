import { describe, expect, it } from "vitest";
import { botHost, parseBotArgs, runBot } from "./bot.js";
import { GhFindError } from "./client.js";

const token = `ghf_${"a".repeat(43)}`;
const cleanupId = "11111111-2222-3333-4444-555555555555";
const confirm = `${cleanupId}.${"b".repeat(24)}`;

/** A scripted bot API: each entry answers one request, in order. */
function harness(replies: { method: string; path: string; status?: number; body: unknown }[]) {
  const seen: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const lines: string[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    seen.push({
      method,
      url,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = replies.shift();
    if (!next || next.method !== method || !url.endsWith(next.path))
      throw new Error(`Unexpected ${method} ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  const run = (args: string[], output = "json", apiKey: string | undefined = token) =>
    runBot(args, {
      host: "https://bot.test",
      apiKey,
      output,
      fetch: fetchStub,
      sleep: async () => {},
      print: (line) => lines.push(line),
    });
  return { run, seen, lines, replies };
}

describe("parseBotArgs", () => {
  it("separates bot options from positionals", () => {
    expect(parseBotArgs(["cleanup", "o/r", "--labels", "all", "--comments", "-n", "5"])).toEqual({
      rest: ["cleanup", "o/r"],
      opts: { "--labels": "all", "--comments": true, "--limit": "5" },
    });
    expect(() => parseBotArgs(["status", "o/r", "--bogus"])).toThrow(/Unknown bot option/);
  });
});

describe("ghfind bot", () => {
  it("requires a personal API token", async () => {
    const h = harness([]);
    await expect(h.run(["status", "o/r"], "json", "")).rejects.toMatchObject({
      code: "personal_token_required",
    });
    await expect(h.run(["status", "o/r"], "json", "machine-key")).rejects.toBeInstanceOf(GhFindError);
    expect(h.seen).toEqual([]);
  });

  it("surfaces API error codes", async () => {
    const h = harness([{ method: "POST", path: "/api/v1/repos/o/r/pause", status: 403, body: { error: "admin_required" } }]);
    await expect(h.run(["pause", "o/r"])).rejects.toMatchObject({ status: 403, code: "admin_required" });
    expect(h.seen[0].auth).toBe(`Bearer ${token}`);
  });

  it("explains how to replace a scan-only token without retrying the action", async () => {
    const h = harness([{ method: "POST", path: "/api/v1/repos/o/r/pause", status: 403, body: { error: "token_scope_required" } }]);
    await expect(h.run(["pause", "o/r"])).rejects.toMatchObject({
      status: 403,
      code: "token_scope_required",
      message: expect.stringContaining('create a new token with "Manage the ghfind Review bot" at https://ghfind.com/integrations'),
    });
    expect(h.seen).toHaveLength(1);
  });

  it("patches only the given settings", async () => {
    const h = harness([{ method: "PATCH", path: "/api/v1/repos/o/r/settings", body: { settings: {} } }]);
    await h.run(["settings", "set", "o/r", "--triage", "on", "--allowed-labels", "bug, feature", "--prompt", "Reply in Chinese"]);
    expect(h.seen[0].body).toEqual({
      triage_enabled: true,
      allowed_labels: ["bug", "feature"],
      comment_prompt: "Reply in Chinese",
    });
    await expect(h.run(["settings", "set", "o/r", "--issues", "maybe"])).rejects.toThrow(/on or off/);
    await expect(h.run(["settings", "set", "o/r"])).rejects.toThrow(/Nothing to set/);
  });

  it("previews a cleanup, waits for the plan and prints the confirm command", async () => {
    const h = harness([
      { method: "POST", path: "/api/v1/repos/o/r/cleanups", status: 202, body: { cleanup: { id: cleanupId, state: "planning" }, confirm_token: confirm } },
      { method: "GET", path: `/api/v1/repos/o/r/cleanups/${cleanupId}`, body: { cleanup: { id: cleanupId, state: "planning" } } },
      {
        method: "GET",
        path: `/api/v1/repos/o/r/cleanups/${cleanupId}`,
        body: { cleanup: { id: cleanupId, state: "planned", summary: { review_labels: 2, bot_active: true } }, items: [] },
      },
    ]);
    await h.run(["cleanup", "o/r", "--labels", "review", "--comments"], "pretty");
    expect(h.seen[0].body).toEqual({ labels: "review", comments: true, delete_label_definitions: false });
    expect(h.lines.join("\n")).toContain(`ghfind bot cleanup confirm o/r ${confirm}`);
    expect(h.lines.join("\n")).toContain("review: labels 2");
    expect(h.lines.join("\n")).toContain("ghfind bot pause");
  });

  it("confirms with the token and can wait for completion", async () => {
    const h = harness([
      { method: "POST", path: `/api/v1/repos/o/r/cleanups/${cleanupId}/confirm`, status: 202, body: { cleanup: { id: cleanupId, state: "running" } } },
      { method: "GET", path: `/api/v1/repos/o/r/cleanups/${cleanupId}`, body: { cleanup: { id: cleanupId, state: "done", done: 3, skipped: 1, total: 4 } } },
    ]);
    await h.run(["cleanup", "confirm", "o/r", confirm, "--wait"]);
    expect(h.seen[0].body).toEqual({ token: confirm });
    expect(JSON.parse(h.lines.join("\n"))).toMatchObject({ cleanup: { state: "done", done: 3 } });
    await expect(h.run(["cleanup", "confirm", "o/r", "nope"])).rejects.toThrow(/Usage/);
  });

  it("validates repositories and backfill limits locally", async () => {
    const h = harness([]);
    await expect(h.run(["status", "not-a-repo"])).rejects.toThrow(/owner\/name/);
    await expect(h.run(["backfill", "o/r", "-n", "500"])).rejects.toThrow(/1-100/);
  });

  it("sends the token only over https, or http on localhost", async () => {
    const h = harness([]);
    await expect(runBot(["status", "o/r", "--bot-host", "http://evil.example"], { host: "https://bot.test", apiKey: token, output: "json" })).rejects.toThrow(/https/);
    expect(botHost("http://localhost:8787/")).toBe("http://localhost:8787");
    expect(botHost("https://bot.ghfind.com")).toBe("https://bot.ghfind.com");
    expect(h.seen).toEqual([]);
  });

  it("keeps waiting through a GitHub quota pause", async () => {
    const h = harness([
      { method: "POST", path: `/api/v1/repos/o/r/cleanups/${cleanupId}/confirm`, status: 202, body: { cleanup: { id: cleanupId, state: "running" } } },
      { method: "GET", path: `/api/v1/repos/o/r/cleanups/${cleanupId}`, status: 503, body: { error: "github_rate_limited" } },
      { method: "GET", path: `/api/v1/repos/o/r/cleanups/${cleanupId}`, status: 429, body: { error: "rate_limited" } },
      { method: "GET", path: `/api/v1/repos/o/r/cleanups/${cleanupId}`, body: { cleanup: { id: cleanupId, state: "done", done: 1, skipped: 0, total: 1 } } },
    ]);
    await h.run(["cleanup", "confirm", "o/r", confirm, "--wait"]);
    expect(JSON.parse(h.lines.join("\n"))).toMatchObject({ cleanup: { state: "done" } });
  });

  it("offers no confirm command when there is nothing to clean up", async () => {
    const h = harness([
      { method: "POST", path: "/api/v1/repos/o/r/cleanups", status: 202, body: { cleanup: { id: cleanupId, state: "planning" }, confirm_token: confirm } },
      { method: "GET", path: `/api/v1/repos/o/r/cleanups/${cleanupId}`, body: { cleanup: { id: cleanupId, state: "done", result: "Nothing to clean up" } } },
    ]);
    await h.run(["cleanup", "o/r", "--labels", "triage"], "pretty");
    expect(h.lines.join("\n")).not.toContain("cleanup confirm");
    expect(h.lines.join("\n")).toContain("Nothing has been changed.");
  });
});
