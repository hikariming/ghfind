import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runIntentPreview } from "../src/intent-preview";
import { DEFAULT_SETTINGS, putSettings } from "../src/settings";
import type { github } from "../src/github";
import { JEV_MODEL } from "../src/jev";
declare const TEST_SQL: string[];
const e = { ...(env as Env), TRIAGE_PROVIDER: "jev", OPENROUTER_API_KEY: "test" };
const form = () => new URLSearchParams({ preview_kind: "issue", preview_title: "Synthetic broken button", preview_body: "Synthetic input" });
const api = vi.fn(async () => [{ name: "bug", description: "Reports broken behavior" }]) as unknown as ReturnType<typeof github>;
beforeAll(async () => { for (const sql of TEST_SQL) await e.DB.prepare(sql).run(); });
beforeEach(async () => {
  await e.DB.prepare("DELETE FROM api_rate").run();
  await e.DB.prepare("DELETE FROM repo_settings").run();
  await putSettings(e, 10, 100, "owner/repo", { ...DEFAULT_SETTINGS, allowedLabels: ["bug", "deleted"] }, "admin");
});
afterEach(() => vi.unstubAllGlobals());
it("previews saved existing labels without GitHub writes or persisting samples", async () => {
  const fetcher = vi.fn(async () => Response.json({ model: JEV_MODEL, answers: { label_0: { type: "noul", noul: 0.98 } } }));
  vi.stubGlobal("fetch", fetcher);
  const result = await runIntentPreview(e, api, 100, "owner/repo", form());
  expect(result.classification.labels).toEqual(["bug"]);
  expect(result.candidateCount).toBe(1);
  expect(await e.DB.prepare("SELECT count(*) n FROM triage_labels").first()).toEqual({ n: 0 });
  expect(await e.DB.prepare("SELECT key,count FROM api_rate").first()).toEqual({ key: "intent-preview:100", count: 1 });
  await expect(runIntentPreview(e, api, 100, "owner/repo", form())).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects transferred owner candidates and invalid duplicate input before paid calls", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(runIntentPreview(e, api, 100, "new-owner/repo", form())).rejects.toMatchObject({ code: "no_candidates" });
  const invalid = form(); invalid.append("preview_kind", "pull_request");
  await expect(runIntentPreview(e, api, 100, "owner/repo", invalid)).rejects.toMatchObject({ code: "invalid_input" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("redacts provider errors and limits failed calls too", async () => {
  const fetcher = vi.fn(async () => { throw new Error("private provider details"); }); vi.stubGlobal("fetch", fetcher);
  await expect(runIntentPreview(e, api, 100, "owner/repo", form())).rejects.toMatchObject({ code: "classifier_unavailable", status: 503, message: "classifier_unavailable" });
  await expect(runIntentPreview(e, api, 100, "owner/repo", form())).rejects.toMatchObject({ code: "rate_limited" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
