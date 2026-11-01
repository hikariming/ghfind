import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ui } from "../src/ui";
import { seal } from "../src/secrets";
import { DEFAULT_SETTINGS, putSettings } from "../src/settings";
import { AIProviderError, getAIProvider, putAIProvider } from "../src/byok";
import { testAIProvider } from "../src/provider-test";
import { ADMIN_MESSAGES } from "../src/admin-i18n";
import { audit } from "../src/audit";

// The provider helper has separate model/network tests. These tests exercise
// actual UI authorization, encrypted persistence, and the explicit test boundary.
vi.mock("../src/provider-test", () => ({ testAIProvider: vi.fn() }));
declare const TEST_SQL: string[];
const origin = "https://bot.example";
const repository = "owner/repo";
const key = "PRIVATE_SYNTHETIC_BYOK_KEY";
const e: Env = { ...(env as Env), BYOK_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", LLM_API_KEY: "PRIVATE_PLATFORM_KEY", TRIAGE_PROVIDER: "llm" };
let csrf: string, cookie: string, administrator: boolean, accessible: boolean, liveId: number, liveName: string, viewerLogin: string;
const requests: string[] = [];
const paths = ["/admin/ai-provider", "/admin/ai-provider/test", "/admin/ai-provider/remove"];
const target = (path = "/admin/ai-provider", extra = "") => `${origin}${path}?installation_id=10&repository=100&lang=zh&repo_page=2&return_q=repo&return_processing=paused${extra}`;
const form = (extra: Record<string,string> = {}) => new URLSearchParams({ csrf, mode: "byok", provider: "llm", base_url: "https://provider.vendor.dev/v1", model: "synthetic-model", api_key: key, ...extra });
const post = (path = paths[0], body = form(), headers: Record<string,string> = { origin }, authenticated = true, url = target(path)) => ui(new Request(url, { method: "POST", headers: { ...(authenticated ? { cookie } : {}), "content-type": "application/x-www-form-urlencoded", ...headers }, body }), e);
const get = (tab = "ai") => ui(new Request(target("/admin/repo", `&tab=${tab}`), { headers: { cookie } }), e);
const stored = () => e.DB.prepare("SELECT * FROM ai_providers WHERE repository=100").first();
const saveFixture = (provider = "llm") => putAIProvider(e, 100, repository, { mode: "byok", provider, base_url: "https://provider.vendor.dev/v1", model: provider === "jev" ? "typesafe/jev-1.13" : "synthetic-model", api_key: key }, "admin");

beforeAll(async () => { for (const sql of TEST_SQL) await e.DB.prepare(sql).run(); });
beforeEach(async () => {
  await e.DB.exec("DELETE FROM sessions; DELETE FROM repo_settings; DELETE FROM ai_providers; DELETE FROM audit_log; DELETE FROM jobs; DELETE FROM cleanups; DELETE FROM cleanup_items; DELETE FROM api_rate;");
  await putSettings(e, 10, 100, repository, { ...DEFAULT_SETTINGS, allowedLabels: ["bug"] }, "admin");
  csrf = crypto.randomUUID(); cookie = `ghfind_bot_session=${csrf}`;
  await e.DB.prepare("INSERT INTO sessions(id,value,expires) VALUES(?,?,?)").bind(`session:${csrf}`, await seal(e, "synthetic-user-token"), Date.now() + 3600000).run();
  administrator = true; accessible = true; liveId = 100; liveName = repository; viewerLogin = "admin"; requests.splice(0);
  vi.mocked(testAIProvider).mockReset().mockResolvedValue({ provider: "llm", model: "synthetic-model" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); requests.push(url);
    if (init.method && init.method !== "GET") throw new Error("Unexpected external write or model call");
    if (url === "https://api.github.com/user/installations?per_page=100&page=1") return Response.json({ installations: [{ id: 10, account: { login: "owner" } }] });
    if (url === "https://api.github.com/user/installations/10/repositories?per_page=100&page=1") return Response.json({ repositories: accessible ? [{ id: 100, full_name: repository }] : [] });
    if (url === `https://api.github.com/repos/${repository}`) return Response.json({ id: liveId, full_name: liveName, permissions: { admin: administrator, push: true } });
    if (url === `https://api.github.com/repos/${repository}/labels?per_page=100&page=1`) return Response.json([{ name: "bug", color: "112233" }]);
    if (url === "https://api.github.com/user") return Response.json({ login: viewerLogin });
    throw new Error(`Unexpected request ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("repository AI service UI", () => {
  it("renders saved metadata, an empty password, confirmation and scoped links without testing", async () => {
    await saveFixture();
    const response = await get(), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(ADMIN_MESSAGES.zh.aiKeySaved);
    expect(html).toContain('id="ai-api-key" type="password"');
    expect(html.match(/<input id="ai-api-key"[^>]+>/)?.[0]).not.toContain("value=");
    expect(html).not.toContain(key);
    expect(html).not.toContain("encrypted_key");
    expect(html).toContain('name="confirm_remove" value="yes" required');
    expect(html).toContain('/admin/ai-provider/test?installation_id=10&amp;lang=zh&amp;repo_page=2&amp;return_q=repo&amp;return_processing=paused&amp;repository=100');
    expect(testAIProvider).not.toHaveBeenCalled();
  });
  it("does not mistake the platform key for the repository's saved key", async () => {
    const html = await (await get()).text();
    expect(html).not.toContain('name="confirm_remove"');
    expect(html).not.toContain(ADMIN_MESSAGES.zh.aiKeySaved);
    expect(html).not.toContain("PRIVATE_PLATFORM_KEY");
    expect(html).toContain('name="api_key"');
    expect(testAIProvider).not.toHaveBeenCalled();
  });
  it("renders read-only metadata but rejects every write or test without live admin", async () => {
    await saveFixture(); administrator = false;
    const html = await (await get()).text();
    expect(html).toContain('action="/admin/ai-provider?');
    expect(html).toContain("<fieldset disabled>");
    for (const path of paths) expect((await post(path, form({ confirm_remove: "yes" }))).status).toBe(403);
    expect(testAIProvider).not.toHaveBeenCalled();
    expect((await getAIProvider(e, 100, repository)).hasKey).toBe(true);
  });
  it.each(paths)("rejects anonymous, CSRF, Origin and wrong method on %s before side effects", async path => {
    for (const [body, headers, auth] of [[form(), { origin }, false], [form(), { origin: "https://evil.example" }, true], [form(), {}, true], [form({ csrf: "wrong" }), { origin }, true]] as const) {
      expect((await post(path, body, headers, auth)).status).toBe(403);
    }
    expect((await ui(new Request(target(path), { headers: { cookie } }), e)).status).toBe(405);
    expect(requests).toEqual([]);
    expect(await stored()).toBeNull();
    expect(testAIProvider).not.toHaveBeenCalled();
  });
  it.each([{ id: 200, name: repository }, { id: 100, name: "new-owner/repo" }])("denies stale live repository identity $name/$id on every action", async ({ id, name }) => {
    await saveFixture(); const before = await stored(); liveId = id; liveName = name;
    for (const path of paths) expect((await post(path, form({ confirm_remove: "yes" }))).status).toBe(403);
    expect(await stored()).toEqual(before);
    expect(testAIProvider).not.toHaveBeenCalled();
  });
  it("rejects wrong installation and inaccessible repositories without storage changes", async () => {
    expect((await post(paths[0], form(), { origin }, true, target().replace("installation_id=10", "installation_id=20"))).status).toBe(404);
    accessible = false;
    for (const path of paths) expect((await post(path)).status).toBe(404);
    expect(await stored()).toBeNull(); expect(testAIProvider).not.toHaveBeenCalled();
  });
  it("saves encrypted configuration, retains navigation and leaves feature opt-ins unchanged", async () => {
    const before = await e.DB.prepare("SELECT * FROM repo_settings WHERE repository=100").first();
    const response = await post();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/repo?installation_id=10&lang=zh&repo_page=2&return_q=repo&return_processing=paused&repository=100&tab=ai&ai=saved");
    expect(JSON.stringify(await stored())).not.toContain(key);
    expect((await getAIProvider(e, 100, repository)).ready).toBe(true);
    expect(await e.DB.prepare("SELECT * FROM repo_settings WHERE repository=100").first()).toEqual(before);
    expect(testAIProvider).not.toHaveBeenCalled();
    expect((await post(paths[1], new URLSearchParams({ csrf }))).status).toBe(303);
    expect(testAIProvider).toHaveBeenCalledExactlyOnceWith(e, 100, repository);
    expect(await e.DB.prepare("SELECT actor,via,detail FROM audit_log WHERE action='ai_provider.test'").first()).toEqual({ actor: "admin", via: "web", detail: JSON.stringify({ provider: "llm", model: "synthetic-model" }) });
  });
  it("keeps a blank unchanged key, but never echoes a rejected replacement key", async () => {
    await saveFixture(); const original = await stored() as { encrypted_key: string };
    expect((await post(paths[0], form({ api_key: "", model: "updated-model" }))).status).toBe(303);
    expect((await stored() as { encrypted_key: string }).encrypted_key).toBe(original.encrypted_key);
    const response = await post(paths[0], form({ base_url: "http://localhost/private", api_key: `${key}-REJECTED` }));
    const html = await response.text();
    expect(response.status).toBe(400); expect(html).toContain(ADMIN_MESSAGES.zh.aiInvalid);
    expect(html).not.toContain(key); expect(html).not.toContain("http://localhost/private");
    expect(html.match(/<input id="ai-api-key"[^>]+>/)?.[0]).not.toContain("value=");
    expect((await stored() as { encrypted_key: string }).encrypted_key).toBe(original.encrypted_key);
    const changed = await post(paths[0], form({ base_url: "https://other.vendor.dev/v1", api_key: "" }));
    expect(changed.status).toBe(400); expect(await changed.text()).toContain(ADMIN_MESSAGES.zh.aiKeyRequired);
  });
  it("rejects duplicate fields and requires an explicit deletion confirmation", async () => {
    await saveFixture(); const before = await stored();
    for (const name of ["mode", "provider", "base_url", "model", "api_key"]) {
      const duplicate = form(); duplicate.append(name, "tampered");
      expect((await post(paths[0], duplicate)).status).toBe(400);
    }
    expect((await post(paths[2], new URLSearchParams({ csrf }))).status).toBe(400);
    const duplicate = new URLSearchParams({ csrf, confirm_remove: "yes" }); duplicate.append("confirm_remove", "no");
    expect((await post(paths[2], duplicate)).status).toBe(400);
    expect(await stored()).toEqual(before);
    expect((await post(paths[2], new URLSearchParams({ csrf, confirm_remove: "yes" }))).status).toBe(303);
    const metadata = await getAIProvider(e, 100, repository);
    expect(metadata.mode).toBe("byok"); expect(metadata.hasKey).toBe(false); expect(metadata.ready).toBe(false);
  });
  it("shows a safe test failure on the AI tab without retaining submitted credentials", async () => {
    await saveFixture(); vi.mocked(testAIProvider).mockRejectedValueOnce(new AIProviderError("unavailable", 503));
    const response = await post(paths[1], form({ api_key: `${key}-UNSAVED` })), html = await response.text();
    expect(response.status).toBe(503); expect(html).toContain(ADMIN_MESSAGES.zh.aiUnavailable);
    expect(html).toContain('tab=ai" aria-current="page"'); expect(html).not.toContain(key);
  });
  it("resolves the audit actor before permitting a connection test", async () => {
    viewerLogin = "invalid_login";
    expect((await post(paths[1], new URLSearchParams({ csrf }))).status).toBe(400);
    expect(testAIProvider).not.toHaveBeenCalled();
    expect(await e.DB.prepare("SELECT count(*) n FROM audit_log WHERE action='ai_provider.test'").first()).toEqual({ n: 0 });
  });
  it("uses repository-scoped Jev capability for the greeting warning", async () => {
    await saveFixture("jev");
    const html = await (await get("settings")).text();
    expect(html).toContain("AI");
    expect(html).toContain('tab=ai');
    // A platform LLM key must not make a Jev-only repository claim greetings work.
    expect(html).toContain(ADMIN_MESSAGES.zh.aiGreetingsUnavailable);
  });
  it("renders friendly AI audit actions in repository, account and global activity without raw details", async () => {
    await saveFixture();
    await audit(e, 100, "admin", "web", "ai_provider.key_remove", { api_key: key });
    await audit(e, 100, "admin", "api", "ai_provider.test", { api_key: key });
    const responses = [await get("activity"), await ui(new Request(`${origin}/admin/activity?installation_id=10&lang=zh`, { headers: { cookie } }), e), await ui(new Request(`${origin}/admin?lang=zh`, { headers: { cookie } }), e)];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const html = await response.text();
      for (const label of [ADMIN_MESSAGES.zh.aiSaved, ADMIN_MESSAGES.zh.aiRemoved, ADMIN_MESSAGES.zh.aiTested]) expect(html).toContain(label);
      for (const action of ["ai_provider.update", "ai_provider.key_remove", "ai_provider.test"]) expect(html).not.toContain(action);
      expect(html).not.toContain(key);
    }
  });
});
