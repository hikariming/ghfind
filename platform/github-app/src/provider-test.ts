import { AIProviderError, getAIProvider, resolveAIEnv } from "./byok";
import { triageConfigured } from "./settings";
import { classifyIntent, firstObject } from "./triage";
import { complete } from "./llm";

// Both callers enforce fresh repository-admin authorization. Testing is an
// explicit model request using saved settings and a synthetic example only.
// No GitHub reads/writes, user sample storage or automatic tests on save.
export async function testAIProvider(
  env: Env,
  repository: number,
  fullName: string,
): Promise<{ provider: "llm" | "jev"; model: string }> {
  const config = await getAIProvider(env, repository, fullName);
  const aiEnv = await resolveAIEnv(env, repository, fullName);
  if (!config.ready || !triageConfigured(aiEnv))
    throw new AIProviderError("unavailable", 503);
  const now = Date.now();
  const rate = await env.DB.prepare(
    "INSERT INTO api_rate(key,slot,count) VALUES(?,?,1) ON CONFLICT(key,slot) DO UPDATE SET count=count+1 RETURNING count",
  ).bind(`ai-provider-test:${repository}`, Math.floor(now / 60_000) * 60_000)
    .first<{ count: number }>();
  if (!rate || rate.count > 1) throw new AIProviderError("rate_limited", 429);
  try {
    if (config.provider === "llm") {
      const answer = firstObject(await complete(
        aiEnv,
        'Classify a synthetic GitHub issue. Allowed label: bug (a reproducible defect). Answer with JSON only: {"labels":["bug"]} or {"labels":[]}.',
        'The application exits with an exception on startup. Expected: it starts successfully.',
        now + 30_000,
      ));
      if (!answer || typeof answer !== "object" || !Array.isArray((answer as {labels?:unknown}).labels) ||
        (answer as {labels:unknown[]}).labels.some(label => label !== "bug"))
        throw new Error("Invalid classifier response");
    } else await classifyIntent(
      aiEnv,
      { title: "Application crashes on startup", body: "The application exits with an exception when opened. Expected: it starts successfully." },
      ["bug"],
      new Map([["bug", { name: "bug", color: "d73a4a", description: "A reproducible defect or unexpected failure in existing behavior." }]]),
      now + 30_000,
    );
    return { provider: config.provider, model: config.model };
  } catch {
    throw new AIProviderError("unavailable", 503);
  }
}
