import { env } from "cloudflare:test";
import { afterEach, describe, it, expect, vi } from "vitest";
import { complete } from "../src/llm";
import { ApiError } from "../src/github";

const KEY = "sk-test-secret-key";
const PROMPT = "classify this private issue text";
const calls: { url: string; init: RequestInit }[] = [];
function reply(status: number, body: string, headers?: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(body, { status, headers });
    }),
  );
}
function llmEnv(extra: Partial<Env> = {}): Env {
  return {
    ...(env as Env),
    LLM_API_KEY: KEY,
    LLM_BASE_URL: "",
    LLM_MODEL: "",
    ...extra,
  };
}
const ok = (content: unknown) =>
  JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
const sent = () => JSON.parse(String(calls[0].init.body));
async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const message = String((error as Error).message);
  expect(message).not.toContain(KEY);
  expect(message).not.toContain(PROMPT);
  return error as Error;
}
afterEach(() => {
  calls.splice(0);
  vi.unstubAllGlobals();
});

describe("llm complete", () => {
  it("redacts an API key reflected by an untrusted model response", async () => {
    reply(200, ok(`Welcome. ${KEY} ${KEY}`));
    const content = await complete(llmEnv(), "sys", PROMPT, Date.now() + 5000);
    expect(content).toBe("Welcome. [redacted] [redacted]");
    expect(content).not.toContain(KEY);
  });
  it("posts to StepFun by default and returns trimmed content", async () => {
    reply(200, ok("  hello  \n"));
    expect(await complete(llmEnv(), "sys", PROMPT, Date.now() + 5000)).toBe(
      "hello",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.stepfun.com/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(
      `Bearer ${KEY}`,
    );
    expect(sent()).toEqual({
      model: "step-3.7-flash",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: PROMPT },
      ],
      temperature: 0.2,
      stream: false,
      reasoning_effort: "low",
    });
  });

  it("omits reasoning_effort for non-StepFun providers", async () => {
    reply(200, ok("x"));
    await complete(
      llmEnv({
        LLM_BASE_URL: "https://api.example.com/v1/",
        LLM_MODEL: "other-model",
      }),
      "s",
      "u",
      Date.now() + 5000,
    );
    expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions");
    expect(sent().model).toBe("other-model");
    expect(sent()).not.toHaveProperty("reasoning_effort");

    calls.splice(0);
    reply(200, ok("x"));
    await complete(
      llmEnv({ LLM_BASE_URL: "https://notstepfun.com/v1" }),
      "s",
      "u",
      Date.now() + 5000,
    );
    expect(sent()).not.toHaveProperty("reasoning_effort");

    calls.splice(0);
    reply(200, ok("x"));
    await complete(
      llmEnv({ LLM_BASE_URL: "https://eu.api.stepfun.com/v1" }),
      "s",
      "u",
      Date.now() + 5000,
    );
    expect(sent().reasoning_effort).toBe("low");
  });

  it("refuses without an API key and makes no request", async () => {
    reply(200, ok("x"));
    for (const key of [undefined, "", "  "])
      await expect(
        complete(llmEnv({ LLM_API_KEY: key }), "s", "u", Date.now() + 5000),
      ).rejects.toThrow("LLM not configured");
    expect(calls).toHaveLength(0);
  });

  it("maps 429 to a retryable ApiError without leaking secrets", async () => {
    reply(429, `{"error":"rate limited for ${KEY}"}`, { "retry-after": "7" });
    const error = await failure(
      complete(llmEnv(), "s", PROMPT, Date.now() + 5000),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, retry: true, quota: false });
    expect((error as ApiError).delay).toBeGreaterThan(6000);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(
      `Bearer ${KEY}`,
    );
  });

  it("rejects malformed and empty bodies", async () => {
    reply(200, "not json");
    expect(
      await failure(complete(llmEnv(), "s", PROMPT, Date.now() + 5000)),
    ).toMatchObject({ status: 502, retry: true });
    for (const body of [
      "{}",
      "[]",
      '{"choices":[]}',
      ok(null),
      ok(42),
      ok("   "),
    ]) {
      reply(200, body);
      await failure(complete(llmEnv(), "s", PROMPT, Date.now() + 5000));
    }
  });
});
