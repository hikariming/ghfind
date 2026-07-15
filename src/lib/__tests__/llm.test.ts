import { afterEach, describe, expect, it, vi } from "vitest";
import { chatStreamEventsWithFallback, type ChatAttemptEvent } from "../llm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatStreamEventsWithFallback telemetry", () => {
  it("reports failed primary and successful fallback lifecycle without secrets", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n'),
      );
    vi.stubGlobal("fetch", fetchMock);

    const attempts: ChatAttemptEvent[] = [];
    const output: string[] = [];
    for await (const event of chatStreamEventsWithFallback(
      [
        { baseURL: "https://primary.example/v1", apiKey: "secret-1", model: "primary-model" },
        { baseURL: "https://fallback.example/v1", apiKey: "secret-2", model: "fallback-model" },
      ],
      [{ role: "user", content: "hello" }],
      { onAttempt: (event) => attempts.push(event) },
    )) {
      if (event.type === "content") output.push(event.text);
    }

    expect(output.join("")).toBe("done");
    expect(attempts.map(({ attempt, phase }) => [attempt, phase])).toEqual([
      [1, "start"],
      [1, "failure"],
      [2, "start"],
      [2, "first_event"],
      [2, "first_content"],
      [2, "success"],
    ]);
    expect(attempts[0]).toMatchObject({
      provider: "primary.example",
      model: "primary-model",
    });
    expect(JSON.stringify(attempts)).not.toContain("secret-1");
    expect(JSON.stringify(attempts)).not.toContain("secret-2");
  });
});
