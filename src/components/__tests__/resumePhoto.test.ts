import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeResumePhoto, renderCroppedResumePhoto } from "../resume/ResumePhotoInput";

afterEach(() => vi.unstubAllGlobals());
describe("local portrait preparation", () => {
  it("rejects unsupported and oversized files before decoding", async () => {
    const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
    await expect(decodeResumePhoto(new File(["svg"], "photo.svg", { type: "image/svg+xml" }))).rejects.toThrow("format");
    await expect(decodeResumePhoto(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "photo.jpg", { type: "image/jpeg" }))).rejects.toThrow("size");
    expect(decode).not.toHaveBeenCalled();
  });
  it("rejects undecodable and oversized images and releases decoded memory", async () => {
    const bitmap = { width: 9000, height: 9000, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    await expect(decodeResumePhoto(new File(["test"], "photo.png", { type: "image/png" }))).rejects.toThrow("dimensions");
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it("renders the crop region, flattens transparency onto white and caps the edge length", () => {
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: vi.fn(() => "data:image/jpeg;base64,/9j/2Q==") };
    vi.stubGlobal("document", { createElement: () => canvas });
    const source = {} as CanvasImageSource;
    expect(renderCroppedResumePhoto(source, 40, 80, 1200, 1400)).toBe("data:image/jpeg;base64,/9j/2Q==");
    expect([canvas.width, canvas.height]).toEqual([514, 600]);
    expect(context.fillStyle).toBe("#fff");
    expect(context.drawImage).toHaveBeenCalledWith(source, 40, 80, 1200, 1400, 0, 0, 514, 600);
  });
  it("keeps small crops at native resolution instead of upscaling", () => {
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: vi.fn(() => "data:image/jpeg;base64,/9j/2Q==") };
    vi.stubGlobal("document", { createElement: () => canvas });
    renderCroppedResumePhoto({} as CanvasImageSource, 0, 0, 300, 350);
    expect([canvas.width, canvas.height]).toEqual([300, 350]);
  });
  it("rejects when the canvas context is unavailable or the result is too large", () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    expect(() => renderCroppedResumePhoto({} as CanvasImageSource, 0, 0, 100, 100)).toThrow("canvas");
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: vi.fn(() => `data:image/jpeg;base64,${"A".repeat(700000)}`) };
    vi.stubGlobal("document", { createElement: () => canvas });
    expect(() => renderCroppedResumePhoto({} as CanvasImageSource, 0, 0, 100, 100)).toThrow("size");
  });
});
