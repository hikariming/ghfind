import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedMediaAsset, MediaRegistration } from "./contract";

const mocks = vi.hoisted(() => ({
  put: vi.fn(), get: vi.fn(), deleteObject: vi.fn(), registerMedia: vi.fn(), getMediaAsset: vi.fn(),
}));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { SOCIAL_FEED_MEDIA: {
  put: mocks.put, get: mocks.get, delete: mocks.deleteObject,
} } }) }));
vi.mock("./api", () => ({
  requireSameOrigin: vi.fn(), requireSocialFeedPublishEnabled: vi.fn(), consumeFeedQuota: vi.fn(), feedActor: () => null,
  requireFeedActor: () => ({ user_id: "github:11" }),
  socialFeedJson: (value: unknown, status = 200) => Response.json(value, { status }),
  socialFeedRoute: async (work: () => Promise<Response>) => { try { return await work(); } catch { return Response.json({ error: "feed_unavailable" }, { status: 503 }); } },
}));
vi.mock("./eligibility", () => ({ requirePublication: vi.fn() }));
vi.mock("./repository", () => ({ getSocialFeedRepository: () => ({ registerMedia: mocks.registerMedia, getMediaAsset: mocks.getMediaAsset }) }));
import { uploadFeedMedia } from "./media";

function uploadRequest(): Request {
  const form = new FormData();
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  form.set("file", new File([bytes], "test.png", { type: "image/png" }));
  form.set("alt_text", "example");
  return new Request("https://ghfind.com/api/feed/media", { method: "POST", body: form });
}
beforeEach(() => { vi.clearAllMocks(); mocks.put.mockResolvedValue(undefined); mocks.deleteObject.mockResolvedValue(undefined); });

describe("media registration commit recovery", () => {
  it("returns the committed asset when the registration response was lost", async () => {
    let saved: FeedMediaAsset | null = null;
    mocks.registerMedia.mockImplementation(async (input: MediaRegistration) => {
      saved = { ...input, status: "ready", created_at: "2026-10-26T00:00:00Z" };
      throw new Error("response lost after commit");
    });
    mocks.getMediaAsset.mockImplementation(async () => saved);
    const response = await uploadFeedMedia(uploadRequest());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ type: "image", alt_text: "example", width: null, height: null });
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });
  it("compensates the uploaded object only after confirming no registration exists", async () => {
    mocks.registerMedia.mockRejectedValue(new Error("not committed"));
    mocks.getMediaAsset.mockResolvedValue(null);
    expect((await uploadFeedMedia(uploadRequest())).status).toBe(503);
    expect(mocks.deleteObject).toHaveBeenCalledTimes(1);
  });
  it("retains the object when commit status cannot be read back", async () => {
    mocks.registerMedia.mockRejectedValue(new Error("response lost"));
    mocks.getMediaAsset.mockRejectedValue(new Error("database unavailable"));
    expect((await uploadFeedMedia(uploadRequest())).status).toBe(503);
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });
});
