import { createPrivateKey, sign } from "node:crypto";

export class ApiError extends Error {
  constructor(
    public status: number,
    public retry: boolean,
    public delay = 0,
    public quota = false,
  ) {
    super(`Upstream HTTP ${status || "transport failure"}`);
  }
}

// A bounded reader also owns cancellation, including stalled response bodies.
export async function readText(
  response: Response | Request,
  signal: AbortSignal,
  limit = 2 * 1024 * 1024,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) {
        cancel();
        throw new Error("Response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function jsonRequest(
  url: string,
  init: RequestInit = {},
  deadline = Date.now() + 60_000,
  transport: typeof fetch = fetch,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new ApiError(0, true));
      },
      Math.max(1, Math.min(60_000, deadline - Date.now())),
    );
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        let response: Response;
        try {
          response = await transport(url, {
            ...init,
            // workerd does not support "error"; reject 3xx below without following.
            redirect: "manual",
            signal: controller.signal,
          });
        } catch {
          throw new ApiError(0, true);
        }
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new ApiError(0, true);
        }
        if (!response.ok) {
          // Preserve known HTTP status/rate-limit headers even if the error
          // response body never finishes. Only an unclassified 403 needs text.
          let text = "";
          if (
            response.status === 403 &&
            !response.headers.has("retry-after") &&
            response.headers.get("x-ratelimit-remaining") !== "0"
          ) {
            try {
              text = await readText(response, controller.signal);
            } catch {
              throw new ApiError(0, true);
            }
          } else {
            void response.body?.cancel().catch(() => {});
          }

          const limited =
            response.status === 429 ||
            (response.status === 403 &&
              (response.headers.get("x-ratelimit-remaining") === "0" ||
                response.headers.has("retry-after") ||
                /secondary rate limit|rate limit exceeded|abuse detection/i.test(
                  text,
                )));
          const retryAfter = response.headers.get("retry-after");
          const parsed =
            retryAfter === null
              ? 0
              : Number.isFinite(Number(retryAfter))
                ? Number(retryAfter) * 1000
                : Date.parse(retryAfter) - Date.now();
          const reset =
            response.headers.get("x-ratelimit-remaining") === "0"
              ? Number(response.headers.get("x-ratelimit-reset")) * 1000 -
                Date.now()
              : 0;
          let delay = Math.max(
            0,
            Number.isFinite(parsed) ? parsed : 0,
            Number.isFinite(reset) ? reset : 0,
          );
          if (limited && delay === 0) delay = 60_000;
          throw new ApiError(
            response.status,
            limited || [408, 500, 502, 503, 504].includes(response.status),
            delay,
            limited && url.startsWith("https://api.github.com"),
          );
        }
        let text: string;
        try {
          text = await readText(response, controller.signal);
        } catch {
          throw new ApiError(0, true);
        }
        if (response.status === 204 || !text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new ApiError(502, true);
        }
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid API object");
  return value as Record<string, unknown>;
}
export function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid identifier");
  return value;
}
export function repositoryName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  )
    throw new Error("Invalid repository");
  return value;
}
export function appJWT(env: Env): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: env.APP_ID })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), createPrivateKey(env.APP_PRIVATE_KEY)).toString("base64url")}`;
}
export function github(token: string, deadline?: number) {
  return (path: string, method = "GET", body?: unknown) =>
    jsonRequest(
      `https://api.github.com${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "ghfind-review",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      deadline,
    );
}
export async function installationToken(
  env: Env,
  installation: number,
  repository?: number,
  deadline?: number,
): Promise<string> {
  const body = record(
    await github(appJWT(env), deadline)(
      `/app/installations/${installation}/access_tokens`,
      "POST",
      {
        ...(repository ? { repository_ids: [repository] } : {}),
        permissions: { pull_requests: "write", issues: "write" },
      },
    ),
  );
  if (typeof body.token !== "string")
    throw new Error("Missing installation token");
  return body.token;
}
