import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareResumePhoto } from "../resume/ResumePhotoInput";

afterEach(() => vi.unstubAllGlobals());
describe("local portrait preparation", () => {
  it("rejects unsupported and oversized files before decoding", async () => {
    const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
    await expect(prepareResumePhoto(new File(["svg"], "photo.svg", { type: "image/svg+xml" }))).rejects.toThrow("format");
    await expect(prepareResumePhoto(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "photo.jpg", { type: "image/jpeg" }))).rejects.toThrow("size");
    expect(decode).not.toHaveBeenCalled();
  });
  it("resizes locally, flattens transparency onto white and releases decoded image memory", async () => {
    const bitmap = { width: 1200, height: 1800, close: vi.fn() };
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: vi.fn(() => "data:image/jpeg;base64,/9j/2Q==") };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal("document", { createElement: () => canvas });
    expect(await prepareResumePhoto(new File(["test"], "photo.png", { type: "image/png" }))).toBe("data:image/jpeg;base64,/9j/2Q==");
    expect([canvas.width, canvas.height]).toEqual([400, 600]);
    expect(context.fillStyle).toBe("#fff");
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 400, 600);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("releases a decoded image even when conversion fails", async () => {
    const bitmap = { width: 100, height: 100, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    await expect(prepareResumePhoto(new File(["test"], "photo.jpg", { type: "image/jpeg" }))).rejects.toThrow("canvas");
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
