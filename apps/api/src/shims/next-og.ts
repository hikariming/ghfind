/**
 * `next/og` shim (wired via the wrangler `alias`): a line-for-line port of
 * next/dist/server/og/image-response.js — lazily load the renderer inside the
 * stream, default `content-type: image/png` and production
 * `cache-control: public, max-age=0, must-revalidate`, caller headers win —
 * over the vendored edge build of the same @vercel/og (scripts/vendor-og.mjs).
 */
import type { ImageResponse as OgImageResponse } from "next/dist/compiled/@vercel/og/index.edge";

type Args = ConstructorParameters<typeof OgImageResponse>;

export class ImageResponse extends Response {
  constructor(...args: Args) {
    const readable = new ReadableStream({
      async start(controller) {
        const { ImageResponse: Og } = await import("vercel-og-edge");
        const imageResponse = new Og(...args);
        if (!imageResponse.body) return controller.close();
        const reader = imageResponse.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          controller.enqueue(value);
        }
      },
    });
    const options = args[1] || {};
    const headers = new Headers({
      "content-type": "image/png",
      "cache-control": "public, max-age=0, must-revalidate",
    });
    if (options.headers) new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    super(readable, { headers, status: options.status, statusText: options.statusText });
  }
}
