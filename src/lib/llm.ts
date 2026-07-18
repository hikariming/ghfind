/**
 * Minimal OpenAI-compatible streaming chat client.
 *
 * Works against any `/chat/completions` endpoint: OpenRouter (default free
 * models), OpenAI, Groq, Gemini's OpenAI-compatible endpoint, or a local model.
 * The default provider is the operator's OpenRouter key; users may bring their
 * own (baseURL + apiKey + model) — those are passed through per request and are
 * never persisted server-side.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** Error thrown when the provider rejects us for quota/auth reasons. */
export class LlmQuotaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Default provider: StepFun (阶跃星辰) — OpenAI-compatible, strong Chinese.
const STEPFUN_BASE_URL = "https://api.stepfun.com/v1";
const STEPFUN_MODEL = "step-3.7-flash";

/**
 * Resolve the default (operator-funded) provider config, or null if unset.
 *
 * Provider-neutral `LLM_*` vars take precedence (StepFun by default). The legacy
 * `OPENROUTER_*` vars are kept as a self-consistent fallback so older deploys
 * keep working — each key is paired only with its own base URL/model so an
 * OpenRouter key is never sent to StepFun (or vice-versa).
 */
export function defaultLlmConfig(): LlmConfig | null {
  if (process.env.LLM_API_KEY) {
    return {
      baseURL: process.env.LLM_BASE_URL || STEPFUN_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      model: process.env.LLM_MODEL || STEPFUN_MODEL,
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0324:free",
    };
  }
  return null;
}

/**
 * Resolve the operator's *fallback* provider (DeepSeek by default), or null if
 * unset. Used only on the default (operator-funded) path: when the primary
 * provider drops/queues the connection or rate-limits before producing any
 * answer text, the roast fails over to this provider instead of erroring out.
 * BYO-key requests never use it — that's the user's own single key/credit.
 *
 * Configure with `LLM_FALLBACK_API_KEY` (+ optional `LLM_FALLBACK_BASE_URL` /
 * `LLM_FALLBACK_MODEL`). DeepSeek's `deepseek-v4-flash` is a fast model, so
 * failover both rescues hard drops AND avoids the primary reasoning model's
 * long chain-of-thought latency.
 */
export function fallbackLlmConfig(): LlmConfig | null {
  if (!process.env.LLM_FALLBACK_API_KEY) return null;
  return {
    baseURL: process.env.LLM_FALLBACK_BASE_URL || "https://api.deepseek.com",
    apiKey: process.env.LLM_FALLBACK_API_KEY,
    model: process.env.LLM_FALLBACK_MODEL || "deepseek-v4-flash",
  };
}

/**
 * Stream a chat completion, yielding text deltas. Throws {@link LlmQuotaError}
 * on 401/402/429 so the caller can prompt the user for their own key.
 */
/** Thrown when the provider stalls past a timeout — distinct from a hard error
 *  so callers can treat it as a transient (retryable) failure, not a bad key. */
export class LlmTimeoutError extends Error {}

// Defaults: a slow flash model still returns its first byte well under 30s, and
// streams tokens far faster than 30s apart. These bound a stalled/queued upstream
// (the real prod failure mode) so the request fails fast instead of hanging the
// whole serverless function until the platform 504s it.
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 30_000;

/** A single streamed event: the model's hidden reasoning (chain-of-thought) or
 *  user-facing answer content. Reasoning is surfaced only as a liveness signal
 *  (a "still thinking" heartbeat) — never rendered to users, since a reasoning
 *  model's CoT leaks internal scoring fields the report is required to hide. */
export interface ChatEvent {
  type: "reasoning" | "content";
  text: string;
}

export interface ChatAttemptEvent {
  attempt: number;
  provider: string;
  model: string;
  phase: "start" | "first_event" | "first_content" | "success" | "failure";
  elapsedMs: number;
  emittedContent?: boolean;
  error?: string;
}

export interface ChatStreamOptions {
  temperature?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  deadlineMs?: number;
  attemptBudgetMs?: number;
  /** Non-secret lifecycle telemetry. Callers can aggregate this into one request log. */
  onAttempt?: (event: ChatAttemptEvent) => void;
}

/** StepFun supports OpenAI's reasoning_effort field. Keep it provider-scoped:
 * fallback and BYO OpenAI-compatible endpoints may reject unknown fields. */
function isStepFunEndpoint(baseURL: string): boolean {
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    return hostname === "stepfun.com" || hostname.endsWith(".stepfun.com");
  } catch {
    return false;
  }
}

/**
 * Stream a chat completion as typed events. Reasoning deltas (`reasoning_content`
 * / `reasoning`, emitted by reasoning models like StepFun's flash tiers ahead of
 * any answer) are yielded as `{type:"reasoning"}`; answer tokens as
 * `{type:"content"}`. {@link chatStream} wraps this to the content-only view.
 */
export async function* chatStreamEvents(
  config: LlmConfig,
  messages: ChatMessage[],
  opts?: ChatStreamOptions,
): AsyncGenerator<ChatEvent> {
  const base = config.baseURL.replace(/\/$/, "");
  const connectMs = opts?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const idleMs = opts?.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const deadlineMs = opts?.deadlineMs;

  // One controller for the whole exchange; a single timer is re-armed before each
  // await so it measures only the provider's wait, not our own processing time.
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    // Never wait past the overall deadline, even if the provider keeps the
    // stream alive with steady reasoning tokens.
    const eff = deadlineMs !== undefined ? Math.min(ms, deadlineMs - Date.now()) : ms;
    if (eff <= 0) {
      ctrl.abort();
      return;
    }
    timer = setTimeout(() => ctrl.abort(), eff);
  };
  const disarm = () => clearTimeout(timer);

  let res: Response;
  try {
    arm(connectMs);
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        // OpenRouter attribution headers (ignored by other providers).
        "HTTP-Referer": process.env.PUBLIC_SITE_URL || "https://ghfind.com",
        "X-Title": "GitHub Roast",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: opts?.temperature ?? 0.85,
        ...(isStepFunEndpoint(base) ? { reasoning_effort: "low" } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    disarm();
    if (ctrl.signal.aborted) throw new LlmTimeoutError(`LLM connect timed out after ${connectMs}ms`);
    throw new Error(`LLM request failed: ${(e as Error).message}`);
  }

  if (res.status === 401 || res.status === 402 || res.status === 429) {
    disarm();
    const body = await res.text().catch(() => "");
    throw new LlmQuotaError(body || `Provider returned ${res.status}`, res.status);
  }
  if (!res.ok || !res.body) {
    disarm();
    const body = await res.text().catch(() => "");
    throw new Error(`LLM error ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      arm(idleMs);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (ctrl.signal.aborted) throw new LlmTimeoutError(`LLM stream stalled (>${idleMs}ms)`);
        throw e;
      }
      disarm();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data) as {
            choices?: {
              delta?: { content?: string; reasoning_content?: string; reasoning?: string };
            }[];
          };
          const delta = json.choices?.[0]?.delta;
          const reasoning = delta?.reasoning_content ?? delta?.reasoning;
          if (reasoning) yield { type: "reasoning", text: reasoning };
          if (delta?.content) yield { type: "content", text: delta.content };
        } catch {
          // ignore keep-alive / partial frames
        }
      }
    }
  } finally {
    disarm();
    // Abort the underlying connection if the consumer stops pulling early (client
    // disconnect) so we don't leak a half-read upstream stream.
    if (!ctrl.signal.aborted) ctrl.abort();
  }
}

/**
 * Try each provider config in order, failing over to the next ONLY when the
 * current one errors *before emitting any answer `content`* — the dominant prod
 * failure, where the primary drops or queues the connection before the first
 * token (e.g. StepFun resetting at ~10s under load). Once answer text has
 * streamed we can't restart on another provider without duplicating output, so
 * the error propagates. Reasoning-only deltas don't count as committed output,
 * so a stall during a long "think" still fails over.
 *
 * Quota errors (401/402/429) fail over too — the operator's primary may be
 * exhausted while the fallback still has credit — and the LAST provider's quota
 * error surfaces, so the caller can still prompt for a BYO key once every
 * operator option is spent. `opts.deadlineMs` caps the total wall-clock across
 * ALL providers (the function-ceiling guard). When `opts.attemptBudgetMs` is set,
 * each provider additionally gets its OWN fresh window of that length — so a
 * primary that stalls to its budget can't leave the fallback with ~0s left.
 */
export async function* chatStreamEventsWithFallback(
  configs: LlmConfig[],
  messages: ChatMessage[],
  opts?: ChatStreamOptions,
): AsyncGenerator<ChatEvent> {
  let lastErr: unknown;
  for (let i = 0; i < configs.length; i++) {
    const isLast = i === configs.length - 1;
    let emittedContent = false;
    let emittedEvent = false;
    const attemptStartedAt = Date.now();
    const provider = (() => {
      try {
        return new URL(configs[i].baseURL).hostname;
      } catch {
        return "unknown";
      }
    })();
    const emitAttempt = (phase: ChatAttemptEvent["phase"], extra: Partial<ChatAttemptEvent> = {}) => {
      try {
        opts?.onAttempt?.({
          attempt: i + 1,
          provider,
          model: configs[i].model,
          phase,
          elapsedMs: Date.now() - attemptStartedAt,
          ...extra,
        });
      } catch {
        // Telemetry must never affect the model stream.
      }
    };
    emitAttempt("start");
    // Fresh per-attempt deadline so each provider gets a full budget from the
    // moment its own attempt starts, still clamped by the overall deadlineMs.
    const attemptOpts =
      opts?.attemptBudgetMs !== undefined
        ? {
            ...opts,
            deadlineMs:
              opts.deadlineMs !== undefined
                ? Math.min(Date.now() + opts.attemptBudgetMs, opts.deadlineMs)
                : Date.now() + opts.attemptBudgetMs,
          }
        : opts;
    try {
      for await (const ev of chatStreamEvents(configs[i], messages, attemptOpts)) {
        if (!emittedEvent) {
          emittedEvent = true;
          emitAttempt("first_event");
        }
        if (ev.type === "content" && !emittedContent) {
          emittedContent = true;
          emitAttempt("first_content");
        }
        yield ev;
      }
      emitAttempt("success", { emittedContent });
      return;
    } catch (e) {
      lastErr = e;
      emitAttempt("failure", {
        emittedContent,
        error: e instanceof Error ? e.name : "unknown",
      });
      // Can't restart on another provider once answer text is committed, and the
      // last provider has nowhere to fall over to — surface the error either way.
      if (emittedContent || isLast) throw e;
      // Otherwise fall through and retry the request on the next provider.
    }
  }
  if (lastErr) throw lastErr;
}

/**
 * Content-only view of {@link chatStreamEvents}: yields just the answer text
 * deltas, dropping reasoning. Unchanged behaviour for all existing callers
 * (e.g. the judge) that only care about the final text.
 */
export async function* chatStream(
  config: LlmConfig,
  messages: ChatMessage[],
  opts?: {
    temperature?: number;
    connectTimeoutMs?: number;
    idleTimeoutMs?: number;
    /** Absolute wall-clock deadline (epoch ms); see {@link chatStreamEvents}. */
    deadlineMs?: number;
  },
): AsyncGenerator<string> {
  for await (const ev of chatStreamEvents(config, messages, opts)) {
    if (ev.type === "content") yield ev.text;
  }
}

/**
 * One-shot, non-streaming completion: accumulates the content deltas from
 * {@link chatStreamEventsWithFallback} into a single string. For callers (e.g.
 * the PK verdict) that want the whole answer, not a stream. Reasoning is dropped.
 */
export async function getCompletionWithFallback(
  configs: LlmConfig[],
  messages: ChatMessage[],
  opts?: Parameters<typeof chatStreamEvents>[2],
): Promise<string> {
  let out = "";
  for await (const ev of chatStreamEventsWithFallback(configs, messages, opts)) {
    if (ev.type === "content") out += ev.text;
  }
  return out;
}
