import { afterEach, describe, expect, it } from "vitest";
import { defaultLlmConfig } from "../llm";

const ORIGINAL_ENV = {
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("defaultLlmConfig", () => {
  afterEach(restoreEnv);

  it("uses OPENAI_API_KEY as a local fallback", () => {
    delete process.env.LLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_MODEL = "gpt-test";

    expect(defaultLlmConfig()).toEqual({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
    });
  });

  it("keeps LLM_API_KEY precedence over OPENAI_API_KEY", () => {
    process.env.LLM_API_KEY = "llm-key";
    process.env.LLM_BASE_URL = "https://llm.example/v1";
    process.env.LLM_MODEL = "llm-model";
    process.env.OPENAI_API_KEY = "openai-key";

    expect(defaultLlmConfig()).toEqual({
      baseURL: "https://llm.example/v1",
      apiKey: "llm-key",
      model: "llm-model",
    });
  });
});
