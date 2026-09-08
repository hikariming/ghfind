import { BridgeError } from "./contract";

export async function readJSONBody(
  request: Request,
  limit: number,
  timeoutMs = 5000,
): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new BridgeError(415, "unsupported_media_type");
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  )
    throw new BridgeError(413, "request_too_large");
  if (!request.body) throw new BridgeError(400, "invalid_request");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BridgeError(408, "body_timeout")),
      timeoutMs,
    );
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new BridgeError(413, "request_too_large");
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new BridgeError(400, "invalid_request");
  }
}
