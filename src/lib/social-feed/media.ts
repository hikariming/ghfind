import { getCloudflareContext } from "@opennextjs/cloudflare";
import { readBoundedBody, FeedBodyTooLarge } from "@/lib/feed-gateway";
import { consumeFeedQuota, feedActor, requireFeedActor, requireSameOrigin, requireSocialFeedPublishEnabled, socialFeedJson, socialFeedRoute } from "./api";
import { SocialFeedError } from "./contract";
import { requirePublication } from "./eligibility";
import { getSocialFeedRepository } from "./repository";

export const FEED_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
interface MediaObject { body: ReadableStream<Uint8Array> }
interface MediaBucket {
  put(key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<MediaObject | null>;
  delete(key: string): Promise<void>;
}
function isBucket(value: unknown): value is MediaBucket {
  return typeof value === "object" && value !== null && "put" in value && typeof value.put === "function" &&
    "get" in value && typeof value.get === "function" && "delete" in value && typeof value.delete === "function";
}
function mediaBucket(): MediaBucket {
  const env: unknown = getCloudflareContext().env;
  if (typeof env !== "object" || env === null || !("SOCIAL_FEED_MEDIA" in env) || !isBucket(env.SOCIAL_FEED_MEDIA)) {
    throw new SocialFeedError("media_unavailable", 503);
  }
  return env.SOCIAL_FEED_MEDIA;
}

/** Only raster images, verified by bytes as well as the declared MIME type. */
export function validFeedImage(bytes: Uint8Array, mime: string): boolean {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (mime === "image/png") return bytes.length >= 24 && starts(137, 80, 78, 71, 13, 10, 26, 10);
  if (mime === "image/jpeg") return bytes.length >= 4 && starts(255, 216, 255);
  if (mime === "image/gif") return bytes.length >= 10 && starts(71, 73, 70, 56) && [55, 57].includes(bytes[4]) && bytes[5] === 97;
  if (mime === "image/webp") return bytes.length >= 16 && starts(82, 73, 70, 70) &&
    bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  return false;
}

export function uploadFeedMedia(request: Request): Promise<Response> {
  return socialFeedRoute(async () => {
    requireSameOrigin(request);
    requireSocialFeedPublishEnabled();
    const actor = requireFeedActor(request);
    await requirePublication(actor);
    await consumeFeedQuota(actor.user_id, "upload");
    const bucket = mediaBucket();
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data;")) throw new SocialFeedError("invalid_media", 400);
    let form: FormData;
    try {
      const bytes = await readBoundedBody(request.body, FEED_MEDIA_MAX_BYTES + 64 * 1024, 15_000);
      form = await new Response(new Uint8Array(bytes).buffer, { headers: { "Content-Type": contentType } }).formData();
    } catch (error) {
      throw new SocialFeedError(error instanceof FeedBodyTooLarge ? "media_too_large" : "invalid_media", error instanceof FeedBodyTooLarge ? 413 : 400);
    }
    if ([...form.keys()].some((key) => key !== "file" && key !== "alt_text") || form.getAll("file").length !== 1 || form.getAll("alt_text").length > 1) {
      throw new SocialFeedError("invalid_media", 400);
    }
    const file = form.get("file");
    const alt = form.get("alt_text");
    if (!(file instanceof File) || (alt !== null && (typeof alt !== "string" || [...alt].length > 1_000))) throw new SocialFeedError("invalid_media", 400);
    if (file.size < 1 || file.size > FEED_MEDIA_MAX_BYTES) throw new SocialFeedError("media_too_large", 413);
    const bytes = await file.arrayBuffer();
    if (!validFeedImage(new Uint8Array(bytes), file.type)) throw new SocialFeedError("invalid_media_type", 415);
    const id = `media_${crypto.randomUUID()}`;
    const storageKey = `posts/${id}`;
    await bucket.put(storageKey, bytes, { httpMetadata: { contentType: file.type } });
    const repository = getSocialFeedRepository();
    try {
      const media = await repository.registerMedia({
        id, owner_user_id: actor.user_id, url: `/api/feed/media/${id}`, storage_key: storageKey,
        mime_type: file.type, size_bytes: bytes.byteLength, alt_text: typeof alt === "string" ? alt.trim() || null : null,
      });
      return socialFeedJson(media, 201);
    } catch (error) {
      // A lost commit response is not proof that registration failed. Read back
      // before compensation; if storage is unavailable, retain the object for
      // orphan cleanup instead of deleting a possibly committed attachment.
      let persisted;
      try { persisted = await repository.getMediaAsset(id); } catch { throw error; }
      if (persisted) {
        if (persisted.status === "ready" && persisted.owner_user_id === actor.user_id &&
          persisted.storage_key === storageKey && persisted.mime_type === file.type && persisted.size_bytes === bytes.byteLength) {
          return socialFeedJson({ id: persisted.id, type: "image", url: persisted.url,
            alt_text: persisted.alt_text ?? null, width: persisted.width ?? null, height: persisted.height ?? null }, 201);
        }
        throw error;
      }
      await bucket.delete(storageKey).catch(() => console.error("social_feed.media_cleanup_failed", { id }));
      throw error;
    }
  });
}

export function getFeedMedia(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return socialFeedRoute(async () => {
    const { id } = await context.params;
    if (!/^media_[a-f0-9-]{36}$/.test(id)) throw new SocialFeedError("not_found", 404);
    const repository = getSocialFeedRepository();
    if (!await repository.canReadMedia(id, feedActor(request)?.user_id)) throw new SocialFeedError("not_found", 404);
    const asset = await repository.getMediaAsset(id);
    if (!asset) throw new SocialFeedError("not_found", 404);
    const object = await mediaBucket().get(asset.storage_key);
    if (!object) throw new SocialFeedError("not_found", 404);
    return new Response(object.body, { headers: {
      "Content-Type": asset.mime_type, "Content-Length": String(asset.size_bytes),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline",
    } });
  });
}
