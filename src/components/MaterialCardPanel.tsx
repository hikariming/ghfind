"use client";

import { useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { trackEvent } from "@/lib/track";

const subscribeNoop = () => () => {};
const getOriginSnapshot = () => window.location.origin;
const getOriginServerSnapshot = () => null;

function withQuery(url: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  return `${url}?${query.toString()}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load material card SVG"));
    image.src = src;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Failed to render material card PNG"));
    }, "image/png");
  });
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function MaterialCardPanel({
  baseUrl,
  username,
  version,
}: {
  baseUrl: string;
  username: string;
  version: string | number;
}) {
  const t = useTranslations("badge");
  const [savingPng, setSavingPng] = useState(false);
  const previewOrigin = useSyncExternalStore(
    subscribeNoop,
    getOriginSnapshot,
    getOriginServerSnapshot,
  );
  const base = baseUrl.replace(/\/$/, "");
  const previewBase = (previewOrigin ?? base).replace(/\/$/, "");
  const previewUrl = withQuery(`${previewBase}/api/material-card/${username}`, {
    theme: "dark",
    preview: "1",
    v: String(version),
  });
  const fileStem = `${username.toLowerCase()}-ghfind-material`;

  const downloadPng = async () => {
    if (savingPng) return;
    setSavingPng(true);
    let svgObjectUrl: string | null = null;

    try {
      const response = await fetch(previewUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to fetch material card: ${response.status}`);
      }
      svgObjectUrl = URL.createObjectURL(await response.blob());
      const image = await loadImage(svgObjectUrl);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D context is unavailable");
      context.drawImage(image, 0, 0);
      downloadBlob(await canvasToPngBlob(canvas), `${fileStem}.png`);
      trackEvent("share_click", { channel: "advx_material_png", surface: "profile" });
    } catch (error) {
      console.error("material card PNG download failed:", error);
    } finally {
      if (svgObjectUrl) URL.revokeObjectURL(svgObjectUrl);
      setSavingPng(false);
    }
  };

  return (
    <section className="bg-transparent p-0">
      <div className="mb-3">
        <h2 className="text-base font-bold text-zinc-200">{t("materialTitle")}</h2>
        <p className="mt-1 text-xs text-zinc-400">{t("materialBlurb")}</p>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={previewUrl}
        alt={t("materialAlt", { username })}
        className="w-full rounded-xl border border-white/10 bg-white/[0.02]"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={downloadPng}
          disabled={savingPng}
          aria-busy={savingPng}
          className="rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:cursor-wait disabled:opacity-60"
        >
          ↓ {t("materialDownloadPng")}
        </button>
        <a
          href={previewUrl}
          download={`${fileStem}.svg`}
          className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs font-semibold text-zinc-300 transition-colors hover:bg-white/5 hover:text-zinc-100"
        >
          ↓ {t("materialDownload")}
        </a>
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs font-semibold text-zinc-300 transition-colors hover:bg-white/5 hover:text-zinc-100"
        >
          {t("materialOpen")} ↗
        </a>
      </div>
    </section>
  );
}
