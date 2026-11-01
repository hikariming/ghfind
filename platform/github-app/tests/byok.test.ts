import { env } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AIProviderError,
  getAIProvider,
  putAIProvider,
  removeAIProviderKey,
  resolveAIEnv,
} from "../src/byok";

declare const TEST_SQL: string[];
const e: Env = {
  ...(env as Env),
  BYOK_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef").replace(
    /=+$/,
    "",
  ),
  TRIAGE_PROVIDER: "jev",
  JEV_MODEL: "typesafe/jev-1.13",
  JEV_BASE_URL: "https://openrouter.ai/api",
  OPENROUTER_API_KEY: "platform-openrouter-test",
  LLM_API_KEY: "platform-llm-test",
};
const input = {
  mode: "byok",
  provider: "llm",
  base_url: "https://api.vendor.com/v1",
  model: "vendor-model",
  api_key: "repository-test-key",
};
const save = (
  value: Record<string, unknown> = input,
  repository = 100,
  fullName = "owner/repo",
) =>
  putAIProvider(e, repository, fullName, value, { login: "admin", via: "web" });
async function row(repository = 100) {
  return e.DB.prepare("SELECT * FROM ai_providers WHERE repository=?")
    .bind(repository)
    .first<Record<string, unknown>>();
}
beforeAll(async () => {
  for (const sql of TEST_SQL) await e.DB.prepare(sql).run();
});
beforeEach(async () => {
  await e.DB.exec("DELETE FROM ai_providers; DELETE FROM audit_log;");
});
afterEach(() => vi.restoreAllMocks());

describe("encrypted repository-owned AI providers", () => {
  it("keeps platform behavior unchanged without a profile and explicitly restores it while retaining ciphertext", async () => {
    expect(await resolveAIEnv(e, 100, "owner/repo")).toBe(e);
    expect(await getAIProvider(e, 100, "owner/repo")).toMatchObject({
      mode: "platform",
      provider: "jev",
      hasKey: true,
      ready: true,
      storageAvailable: true,
      updatedAt: null,
    });
    await save();
    const ciphertext = (await row())?.encrypted_key;
    const metadata = await save({ mode: "platform" });
    expect(metadata).toMatchObject({
      mode: "platform",
      provider: "jev",
      baseUrl: "https://openrouter.ai/api",
      ready: true,
    });
    expect((await row())?.encrypted_key).toBe(ciphertext);
    expect(await resolveAIEnv(e, 100, "owner/repo")).toBe(e);
    expect((await save({ ...input, api_key: "" })).mode).toBe("byok");
  });

  it("stores random AES-GCM ciphertext only and never returns or audits either stored or platform keys", async () => {
    const metadata = await save();
    const first = await row();
    expect(metadata).toMatchObject({
      mode: "byok",
      provider: "llm",
      hasKey: true,
      ready: true,
      storageAvailable: true,
    });
    expect(first?.encrypted_key).toMatch(
      /^v1\.[a-zA-Z0-9_-]{16}\.[a-zA-Z0-9_-]+$/,
    );
    expect(Object.keys(first!)).not.toContain("api_key");
    expect(JSON.stringify(first)).not.toContain(input.api_key);
    const audit = (await e.DB.prepare("SELECT * FROM audit_log").all()).results;
    const exposed = JSON.stringify([
      metadata,
      await getAIProvider(e, 100, "owner/repo"),
      audit,
    ]);
    for (const secret of [
      input.api_key,
      String(first?.encrypted_key),
      e.OPENROUTER_API_KEY!,
      e.LLM_API_KEY!,
    ])
      expect(exposed).not.toContain(secret);
    expect(audit[0]).toMatchObject({
      actor: "admin",
      via: "web",
      action: "ai_provider.update",
    });
    await save();
    expect((await row())?.encrypted_key).not.toBe(first?.encrypted_key);
  });

  it("resolves only the repository key and suppresses platform keys and greetings for Jev BYOK", async () => {
    await save({ ...input, api_key: `  ${input.api_key}  ` });
    const llm = await resolveAIEnv(e, 100, "owner/repo");
    expect(llm).toMatchObject({
      TRIAGE_PROVIDER: "llm",
      LLM_API_KEY: input.api_key,
      LLM_BASE_URL: input.base_url,
      LLM_MODEL: input.model,
      BYOK_REQUIRE_PUBLIC_ENDPOINT: true,
    });
    expect(llm.OPENROUTER_API_KEY).toBeUndefined();
    expect(llm.DB).toBe(e.DB);
    expect(llm.SCORE).toBe(e.SCORE);
    await save({
      ...input,
      provider: "jev",
      base_url: "https://openrouter.ai/api",
      model: "typesafe/jev-1.13",
      api_key: "repository-jev-test",
    });
    const jev = await resolveAIEnv(e, 100, "owner/repo");
    expect(jev).toMatchObject({
      TRIAGE_PROVIDER: "jev",
      OPENROUTER_API_KEY: "repository-jev-test",
      JEV_BASE_URL: "https://openrouter.ai/api",
      JEV_MODEL: "typesafe/jev-1.13",
      BYOK_REQUIRE_PUBLIC_ENDPOINT: true,
    });
    expect(jev.LLM_API_KEY).toBeUndefined();
    expect(e.LLM_API_KEY).toBe("platform-llm-test");
    expect((await resolveAIEnv(e, 200, "other/repo")).OPENROUTER_API_KEY).toBe(
      e.OPENROUTER_API_KEY,
    );
  });

  it("retains blank/omitted keys only for an unchanged canonical URL, provider and owner", async () => {
    await save();
    const ciphertext = (await row())?.encrypted_key;
    const { api_key: _, ...withoutKey } = input;
    await save({
      ...withoutKey,
      base_url: " HTTPS://API.VENDOR.COM:443/v1/// ",
      model: "next-model",
    });
    expect((await row())?.encrypted_key).toBe(ciphertext);
    expect((await resolveAIEnv(e, 100, "owner/renamed")).LLM_API_KEY).toBe(
      input.api_key,
    );
    const before = await row();
    for (const value of [
      { ...withoutKey, base_url: "https://other.vendor.com/v1" },
      { ...withoutKey, base_url: "https://api.vendor.com/v2" },
      { ...withoutKey, provider: "jev", model: "typesafe/jev-1.13" },
    ])
      await expect(save(value)).rejects.toMatchObject({
        code: "key_required",
        status: 400,
      });
    await expect(save(withoutKey, 100, "new-owner/repo")).rejects.toMatchObject(
      { code: "key_required" },
    );
    await expect(save(withoutKey, 200, "owner/other")).rejects.toMatchObject({
      code: "key_required",
    });
    expect(await row()).toEqual(before);
  });

  it("survives same-owner rename but invalidates transfers and binds ciphertext against cross-repo and endpoint tampering", async () => {
    await save();
    expect((await resolveAIEnv(e, 100, "OWNER/new-name")).LLM_API_KEY).toBe(
      input.api_key,
    );
    const transferred = await getAIProvider(e, 100, "new-owner/repo");
    expect(transferred).toMatchObject({
      mode: "byok",
      ready: false,
      hasKey: false,
      baseUrl: "",
      model: "",
    });
    expect(
      (await resolveAIEnv(e, 100, "new-owner/repo")).LLM_API_KEY,
    ).toBeUndefined();
    expect(
      (await resolveAIEnv(e, 100, "new-owner/repo")).OPENROUTER_API_KEY,
    ).toBeUndefined();
    await e.DB.prepare(
      "INSERT INTO ai_providers SELECT 200,owner,mode,provider,base_url,model,encrypted_key,updated,updated_by FROM ai_providers WHERE repository=100",
    ).run();
    expect((await getAIProvider(e, 200, "owner/copy")).ready).toBe(false);
    expect(
      (await resolveAIEnv(e, 200, "owner/copy")).LLM_API_KEY,
    ).toBeUndefined();
    await e.DB.prepare(
      "UPDATE ai_providers SET base_url='https://other.vendor.com/v1' WHERE repository=100",
    ).run();
    expect((await getAIProvider(e, 100, "owner/repo")).ready).toBe(false);
    expect(
      (await resolveAIEnv(e, 100, "owner/repo")).LLM_API_KEY,
    ).toBeUndefined();
    await e.DB.prepare(
      "UPDATE ai_providers SET base_url=?,owner='new-owner' WHERE repository=100",
    )
      .bind(input.base_url)
      .run();
    expect(
      (await resolveAIEnv(e, 100, "new-owner/repo")).LLM_API_KEY,
    ).toBeUndefined();
    await save({ ...input, api_key: "new-owner-key" }, 100, "new-owner/repo");
    expect((await resolveAIEnv(e, 100, "new-owner/repo")).LLM_API_KEY).toBe(
      "new-owner-key",
    );
  });

  it("key removal retains BYOK without fallback and requires a fresh key to resume", async () => {
    await save();
    await save({ mode: "platform" });
    const metadata = await removeAIProviderKey(e, 100, "owner/repo", {
      login: "api-admin",
      via: "api",
    });
    expect(metadata).toMatchObject({
      mode: "byok",
      provider: "llm",
      hasKey: false,
      ready: false,
      baseUrl: input.base_url,
    });
    expect((await row())?.encrypted_key).toBeNull();
    const disabled = await resolveAIEnv(e, 100, "owner/repo");
    expect(disabled.OPENROUTER_API_KEY).toBeUndefined();
    expect(disabled.LLM_API_KEY).toBeUndefined();
    await expect(save({ ...input, api_key: "" })).rejects.toMatchObject({
      code: "key_required",
    });
    expect(
      await e.DB.prepare(
        "SELECT via,action FROM audit_log ORDER BY id DESC LIMIT 1",
      ).first(),
    ).toEqual({ via: "api", action: "ai_provider.key_remove" });
  });

  it("fails closed for missing/bad encryption secrets and corrupted ciphertext without breaking score bindings", async () => {
    await save();
    for (const setting of [
      undefined,
      "",
      "not-base64",
      btoa("short"),
      btoa("fedcba9876543210fedcba9876543210").replace(/=+$/, ""),
    ]) {
      const broken = { ...e, BYOK_ENCRYPTION_KEY: setting };
      expect((await getAIProvider(broken, 100, "owner/repo")).ready).toBe(
        false,
      );
      const disabled = await resolveAIEnv(broken, 100, "owner/repo");
      expect(disabled.LLM_API_KEY).toBeUndefined();
      expect(disabled.OPENROUTER_API_KEY).toBeUndefined();
      expect(disabled.SCORE).toBe(e.SCORE);
    }
    const stored = String((await row())?.encrypted_key);
    const parts = stored.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    await e.DB.prepare(
      "UPDATE ai_providers SET encrypted_key=? WHERE repository=100",
    )
      .bind(parts.join("."))
      .run();
    expect(
      (await resolveAIEnv(e, 100, "owner/repo")).LLM_API_KEY,
    ).toBeUndefined();
    await e.DB.prepare(
      "UPDATE ai_providers SET encrypted_key='v1.bad.corrupted' WHERE repository=100",
    ).run();
    expect((await getAIProvider(e, 100, "owner/repo")).ready).toBe(false);
    await expect(save({ ...input, api_key: "" })).rejects.toMatchObject({
      code: "key_required",
    });
    await expect(
      putAIProvider(
        { ...e, BYOK_ENCRYPTION_KEY: undefined },
        100,
        "owner/repo",
        input,
        "admin",
      ),
    ).rejects.toMatchObject({ code: "storage_unavailable", status: 503 });
  });

  it("disables AI when migration/storage is unavailable and never echoes database errors", async () => {
    await e.DB.exec("ALTER TABLE ai_providers RENAME TO ai_providers_offline;");
    try {
      expect(await getAIProvider(e, 100, "owner/repo")).toMatchObject({
        storageAvailable: false,
        ready: false,
      });
      const disabled = await resolveAIEnv(e, 100, "owner/repo");
      expect(disabled.OPENROUTER_API_KEY).toBeUndefined();
      expect(disabled.LLM_API_KEY).toBeUndefined();
      expect(disabled.SCORE).toBe(e.SCORE);
      await expect(save()).rejects.toMatchObject({
        code: "storage_unavailable",
        status: 503,
        message: "AI provider storage_unavailable",
      });
    } finally {
      await e.DB.exec(
        "ALTER TABLE ai_providers_offline RENAME TO ai_providers;",
      );
    }
    await e.DB.exec("ALTER TABLE audit_log RENAME TO audit_log_offline;");
    try {
      await expect(save()).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect(await row()).toBeNull();
    } finally {
      await e.DB.exec("ALTER TABLE audit_log_offline RENAME TO audit_log;");
    }
    const spy = vi
      .spyOn(e.DB, "batch")
      .mockRejectedValue(new Error("private database error"));
    await expect(save()).rejects.toMatchObject({
      code: "storage_unavailable",
      message: "AI provider storage_unavailable",
    });
    expect(await row()).toBeNull();
    spy.mockRestore();
  });

  it("rejects invalid inputs before writes and never saves plaintext in error details", async () => {
    for (const value of [
      { ...input, mode: "unknown" },
      { ...input, provider: "other" },
      { ...input, extra: "unknown" },
      { ...input, api_key: "short" },
      { ...input, api_key: "test key with spaces" },
      { ...input, api_key: "latin1-key-\u00e9" },
      { ...input, api_key: "unicode-key-密钥" },
      { ...input, api_key: "\u00a0" },
      { ...input, api_key: "key\r\nsecret" },
      { ...input, api_key: "k".repeat(4097) },
      { ...input, api_key: 123 },
      { ...input, model: "" },
      { ...input, model: "x".repeat(201) },
      { ...input, model: "model\nprivate" },
      { ...input, provider: "jev", model: "other/model" },
      { ...input, base_url: "http://localhost/private" },
      { ...input, base_url: "https://127.0.0.1/api" },
      { ...input, base_url: "https://api.vendor.com?key=secret" },
    ])
      await expect(save(value)).rejects.toMatchObject({
        code: "invalid_config",
        message: "AI provider invalid_config",
      });
    for (const repository of [0, -1, 1.5, NaN])
      await expect(save(input, repository)).rejects.toBeInstanceOf(
        AIProviderError,
      );
    await expect(save(input, 100, "invalid-name")).rejects.toMatchObject({
      code: "invalid_config",
    });
    await expect(
      putAIProvider(e, 100, "owner/repo", input, "invalid\nactor"),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(
      (await e.DB.prepare("SELECT count(*) AS count FROM ai_providers").first())
        ?.count,
    ).toBe(0);
    expect(
      (await e.DB.prepare("SELECT count(*) AS count FROM audit_log").first())
        ?.count,
    ).toBe(0);
  });
});
