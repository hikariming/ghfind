import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { putAIProvider, removeAIProviderKey } from "../src/byok";
import { testAIProvider } from "../src/provider-test";
import { JEV_MODEL } from "../src/jev";

declare const TEST_SQL: string[];
const e: Env = { ...(env as Env), BYOK_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", TRIAGE_PROVIDER: "llm", LLM_API_KEY: "platform-secret-must-not-be-used", OPENROUTER_API_KEY: "platform-jev-secret-must-not-be-used" };
const key = "user-private-provider-key";
const fullName = "owner/repository";
let answer: unknown;
let status = 200;
let privateAddress = false;
const calls: {url: string; init: RequestInit}[] = [];
const save = (provider: "llm" | "jev" = "llm") => putAIProvider(e, 100, fullName, { mode: "byok", provider, base_url: "https://openrouter.ai/api", model: provider === "jev" ? JEV_MODEL : "openai/gpt-4o-mini", api_key: key }, "admin");
beforeAll(async () => { for (const sql of TEST_SQL) await e.DB.prepare(sql).run(); });
beforeEach(async () => {
  await e.DB.exec("DELETE FROM ai_providers; DELETE FROM api_rate; DELETE FROM audit_log;");
  calls.splice(0); status = 200; privateAddress = false;
  answer = {choices:[{message:{content:'{"labels":["bug"]}'}}]};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); calls.push({url,init});
    if (url.startsWith("https://cloudflare-dns.com/dns-query?name=openrouter.ai&"))
      return Response.json({Status:0,Answer:url.endsWith("type=1")?[{name:"openrouter.ai",type:1,data:privateAddress?"10.0.0.1":"104.18.3.115"}]:[]});
    return Response.json(answer,{status});
  }));
});
afterEach(() => vi.unstubAllGlobals());
it("tests the saved user OpenAI service with synthetic content only and a capped output budget", async () => {
  await save();
  expect(await testAIProvider(e, 100, fullName)).toEqual({provider:"llm",model:"openai/gpt-4o-mini"});
  const model = calls.filter(call=>!call.url.startsWith("https://cloudflare-dns.com"));
  expect(model).toHaveLength(1);
  expect(model[0].url).toBe("https://openrouter.ai/api/chat/completions");
  expect(new Headers(model[0].init.headers).get("authorization")).toBe(`Bearer ${key}`);
  expect(JSON.parse(String(model[0].init.body)).max_tokens).toBe(512);
  expect(calls.every(call=>!call.url.startsWith("https://api.github.com"))).toBe(true);
  await expect(testAIProvider(e,100,fullName)).rejects.toMatchObject({code:"rate_limited",status:429});
  expect(await e.DB.prepare("SELECT count(*) n FROM ai_providers").first()).toEqual({n:1});
  expect(await e.DB.prepare("SELECT count(*) n FROM jobs").first()).toEqual({n:0});
});
it("tests saved Jev credentials through the typed Decisions endpoint", async () => {
  await save("jev");
  answer = {model:JEV_MODEL,answers:{label_0:{type:"noul",noul:0.98}}};
  expect(await testAIProvider(e,100,fullName)).toEqual({provider:"jev",model:JEV_MODEL});
  const model = calls.find(call=>call.url.endsWith("/alpha/decisions"))!;
  expect(new Headers(model.init.headers).get("authorization")).toBe(`Bearer ${key}`);
  const payload = JSON.parse(String(model.init.body));
  expect(Object.keys(payload.questions)).toEqual(["label_0"]);
  expect(payload.state.title).toBe("Application crashes on startup");
  expect(calls.some(call=>call.url.endsWith("/chat/completions"))).toBe(false);
});
it("rejects malformed classifier output rather than declaring a working connection", async () => {
  await save(); answer={choices:[{message:{content:"private unusable content"}}]};
  await expect(testAIProvider(e,100,fullName)).rejects.toMatchObject({code:"unavailable",status:503,message:"AI provider unavailable"});
});
it("never sends a user key when the provider resolves to a private network", async () => {
  await save(); privateAddress=true;
  await expect(testAIProvider(e,100,fullName)).rejects.toMatchObject({code:"unavailable",status:503});
  expect(calls).toHaveLength(2);
  expect(calls.every(call=>!new Headers(call.init.headers).has("authorization"))).toBe(true);
});
it("does not use platform credentials after removing BYOK or provider authentication failure", async () => {
  await save(); await removeAIProviderKey(e,100,fullName,"admin");
  await expect(testAIProvider(e,100,fullName)).rejects.toMatchObject({code:"unavailable"});
  expect(calls).toEqual([]);
  await save(); status=401; answer={error:key};
  await expect(testAIProvider(e,100,fullName)).rejects.toMatchObject({code:"unavailable",message:"AI provider unavailable"});
  const model=calls.find(call=>call.url.endsWith("/chat/completions"))!;
  expect(new Headers(model.init.headers).get("authorization")).toBe(`Bearer ${key}`);
  expect(calls.filter(call=>call.url.endsWith("/chat/completions"))).toHaveLength(1);
});
