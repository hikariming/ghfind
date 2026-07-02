"use client";

const CARD_READY_TIMEOUT_MS = 2500;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function waitForShareCardReady(node: HTMLElement) {
  const start = performance.now();
  while (
    node.dataset.shareCardReady !== "true" &&
    performance.now() - start < CARD_READY_TIMEOUT_MS
  ) {
    await delay(50);
  }
}

async function waitForImages(node: HTMLElement) {
  const images = Array.from(node.querySelectorAll("img"));
  await Promise.all(
    images.map(async (img) => {
      if (img.complete && img.naturalWidth > 0) return;
      if (typeof img.decode === "function") {
        await img.decode().catch(() => undefined);
        return;
      }
      await new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }),
  );
}

export async function createShareCardBlob(node: HTMLElement): Promise<Blob | null> {
  await waitForShareCardReady(node);
  await document.fonts?.ready.catch(() => undefined);
  await waitForImages(node);
  // Let React state, decoded images, and computed styles settle before cloning.
  await nextFrame();
  await nextFrame();

  const { toBlob } = await import("html-to-image");
  return toBlob(node, {
    pixelRatio: 2,
    cacheBust: true,
    backgroundColor: "#0a0a0b",
  });
}
