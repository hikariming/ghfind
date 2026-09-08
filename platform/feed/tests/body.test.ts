import { expect, it } from "vitest";
import { readJSONBody } from "../src/body";

function request(body: BodyInit, contentType = "application/json") {
  return new Request("https://adapter/internal/feed/governance/v1/review", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}
it("bounds actual bytes, exact JSON media and UTF-8 for private capability bodies", async () => {
  await expect(
    readJSONBody(
      request('{"label":"标签"}', "application/json; charset=utf-8"),
      32,
    ),
  ).resolves.toEqual({ label: "标签" });
  await expect(
    readJSONBody(request("{}", "application/json-forged"), 32),
  ).rejects.toMatchObject({ status: 415 });
  await expect(
    readJSONBody(request(new Uint8Array([0xff])), 32),
  ).rejects.toMatchObject({ status: 400 });
  await expect(readJSONBody(request("x".repeat(33)), 32)).rejects.toMatchObject(
    { status: 413 },
  );
});
it("a stalled read or cancellation cannot outlive the total body deadline", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  await expect(readJSONBody(request(stream), 32, 10)).rejects.toMatchObject({
    status: 408,
    code: "body_timeout",
  });
  expect(cancelled).toBe(true);
});
