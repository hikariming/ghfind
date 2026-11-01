import { describe, expect, it, vi } from "vitest";
import { requestContext } from "../request-context";
import { after } from "../shims/next-server";

function inRequest(run: () => void) {
  const pending: Promise<unknown>[] = [];
  requestContext.run({ request: new Request("https://ghfind.test/api/scan"), waitUntil: (p) => pending.push(p) }, run);
  return pending;
}

describe("after()", () => {
  it("defers the task past the response and keeps it alive with waitUntil", async () => {
    const task = vi.fn();
    const pending = inRequest(() => after(task));
    expect(pending).toHaveLength(1);
    expect(task).not.toHaveBeenCalled();
    await Promise.all(pending);
    expect(task).toHaveBeenCalledOnce();
  });

  it("logs a failing task instead of rejecting waitUntil", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = inRequest(() => after(() => Promise.reject(new Error("boom"))));
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(log).toHaveBeenCalledWith("after.failed", expect.any(Error));
    log.mockRestore();
  });

  it("refuses to run outside a request", () => {
    expect(() => after(() => {})).toThrow("after() called outside a request");
  });
});
