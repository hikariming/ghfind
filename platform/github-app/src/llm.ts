import { record } from "./github";
import { aiJsonRequest } from "./provider-http";

// Optional secret: `wrangler types` only emits required secrets, so declare it here.
declare global {
  interface Env {
    LLM_API_KEY?: string;
  }
}

const BASE_URL = "https://api.stepfun.com/v1";
const MODEL = "step-3.7-flash";

// OpenAI-compatible, non-streaming. Errors never carry the key or prompt text.
export async function complete(
  env: Env,
  system: string,
  user: string,
  deadline: number,
): Promise<string> {
  const key = env.LLM_API_KEY?.trim();
  if (!key) throw new Error("LLM not configured");
  const base = (env.LLM_BASE_URL?.trim() || BASE_URL).replace(/\/+$/, "");
  const host = new URL(base).hostname;
  // reasoning_effort is StepFun-scoped; other providers may reject it.
  const stepfun = host === "stepfun.com" || host.endsWith(".stepfun.com");
  const body = record(
    await aiJsonRequest(
      env,
      `${base}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": "ghfind-review",
        },
        body: JSON.stringify({
          model: env.LLM_MODEL?.trim() || MODEL,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.2,
          stream: false,
          ...(env.BYOK_REQUIRE_PUBLIC_ENDPOINT ? { max_tokens: 512 } : {}),
          ...(stepfun ? { reasoning_effort: "low" } : {}),
        }),
      },
      deadline,
    ),
  );
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const content =
    choice && typeof choice === "object"
      ? (choice as { message?: { content?: unknown } }).message?.content
      : undefined;
  if (typeof content !== "string" || !content.trim())
    throw new Error("Empty LLM response");
  // An untrusted provider must not publish the credential it received in an
  // issue greeting, even if it reflects Authorization into its response.
  return content.replaceAll(key, "[redacted]").trim();
}
