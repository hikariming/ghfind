import { describe, expect, it, vi } from "vitest";
import { consumeRoastStream, decodeRoastMeta } from "../roast-stream";
import type { RoastMeta } from "../types";

const META: RoastMeta = {
  final_score: 55.5,
  tier: "人上人",
  tier_label: "mid",
  delta: 3,
  percentile: null,
  tags: { zh: ["标签"], en: ["tag"] },
  roast_line: { zh: "中文一句", en: "one liner" },
};

const metaB64 = () => Buffer.from(JSON.stringify(META)).toString("base64");
const encodeMeta = metaB64; // alias for readability in tests

/** Build a minimal Response-like object streaming the given chunks. */
function makeRes(chunks: (string | Uint8Array)[], metaHeader?: string): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      }
      controller.close();
    },
  });
  const headers = new Headers();
  if (metaHeader) headers.set("X-Roast-Meta", metaHeader);
  return { headers, body: stream } as unknown as Response;
}

// Frame = separator (\x1f) + type char + payload + newline.
const frame = (type: "T" | "M" | "E", payload: string) => `\x1f${type}${payload}\n`;

describe("decodeRoastMeta", () => {
  it("round-trips a base64 RoastMeta", () => {
    expect(decodeRoastMeta(metaB64())).toEqual(META);
  });

  it("returns null on malformed input", () => {
    expect(decodeRoastMeta("not-base64-json!!!")).toBeNull();
  });
});

describe("consumeRoastStream", () => {
  it("treats a frameless body as pure report markdown (cached fast path)", async () => {
    const onReport = vi.fn();
    const onMeta = vi.fn();
    const res = makeRes(["# Report\n", "more text"]);
    const out = await consumeRoastStream(res, { onReport, onMeta });
    expect(out.errored).toBe(false);
    expect(out.report).toBe("# Report\nmore text");
    expect(onReport).toHaveBeenLastCalledWith("# Report\nmore text");
    expect(onMeta).not.toHaveBeenCalled();
  });

  it("parses T progress, M meta, then streams the report", async () => {
    const onThinking = vi.fn();
    const onMeta = vi.fn();
    const onReport = vi.fn();
    const res = makeRes([
      frame("T", "calibrating…"),
      frame("M", encodeMeta()),
      "## roast body",
    ]);
    const out = await consumeRoastStream(res, { onThinking, onMeta, onReport });
    expect(out.errored).toBe(false);
    expect(onThinking).toHaveBeenCalledWith("calibrating…");
    expect(onMeta).toHaveBeenCalledWith(META);
    expect(out.report).toBe("## roast body");
  });

  it("reads the X-Roast-Meta header before the body", async () => {
    const onMeta = vi.fn();
    const res = makeRes(["plain body"], encodeMeta());
    await consumeRoastStream(res, { onMeta });
    expect(onMeta).toHaveBeenCalledWith(META);
  });

  it("surfaces an E-frame error and stops", async () => {
    const onError = vi.fn();
    const onReport = vi.fn();
    const res = makeRes([
      frame("E", JSON.stringify({ error: "roast_failed" })),
      "should-not-appear",
    ]);
    const out = await consumeRoastStream(res, { onError, onReport });
    expect(out.errored).toBe(true);
    expect(onError).toHaveBeenCalledWith({ error: "roast_failed" });
    expect(out.report).toBe("");
  });

  it("passes a stale report fallback carried by an E-frame", async () => {
    const onError = vi.fn();
    const fallbackMeta = { ...META, final_score: 42 };
    const fallback = { report: "## previous release", meta: fallbackMeta };
    const res = makeRes([frame("E", JSON.stringify({ error: "roast_failed", fallback }))]);

    const out = await consumeRoastStream(res, { onError });

    expect(out.errored).toBe(true);
    expect(onError).toHaveBeenCalledWith({ error: "roast_failed", fallback });
  });

  it("handles control frames split across chunk boundaries", async () => {
    const b64 = encodeMeta();
    const tFrame = frame("T", "half-and-half");
    const mFrame = frame("M", b64);
    const body = "final markdown";
    // Slice each frame mid-way so the parser must buffer partial control lines.
    const joined = tFrame + mFrame + body;
    const mid = Math.floor(joined.length / 2);
    const res = makeRes([joined.slice(0, mid), joined.slice(mid)]);
    const onThinking = vi.fn();
    const onMeta = vi.fn();
    const out = await consumeRoastStream(res, { onThinking, onMeta });
    expect(onThinking).toHaveBeenCalledWith("half-and-half");
    expect(onMeta).toHaveBeenCalledWith(META);
    expect(out.report).toBe(body);
    expect(out.errored).toBe(false);
  });
});
