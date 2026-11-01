// @cloudflare/workers-types declares `const Buffer: any`, which hides the
// encoding overload of @types/node's Buffer#toString from shared src/lib code
// (randomBytes(n).toString("base64url")). Restore it; nodejs_compat provides
// the real implementation at runtime.
interface Buffer {
  toString(encoding?: BufferEncoding, start?: number, end?: number): string;
}
