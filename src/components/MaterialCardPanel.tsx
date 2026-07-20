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

interface MaterialCardAssetProps {
  baseUrl: string;
  username: string;
  version: string | number;
}

function useMaterialCardAsset({ baseUrl, username, version }: MaterialCardAssetProps) {
  const previewOrigin = useSyncExternalStore(
    subscribeNoop,
    getOriginSnapshot,
    getOriginServerSnapshot,
  );
  const base = baseUrl.replace(/\/$/, "");
  const previewBase = (previewOrigin ?? base).replace(/\/$/, "");
  return {
    previewUrl: withQuery(`${previewBase}/api/material-card/${username}`, {
      theme: "dark",
      preview: "1",
      v: String(version),
    }),
    fileStem: `${username.toLowerCase()}-ghfind-material`,
  };
}

async function materialCardPng(previewUrl: string): Promise<Blob> {
  const response = await fetch(previewUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch material card: ${response.status}`);
  }
  const svgObjectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = await loadImage(svgObjectUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(image, 0, 0);
    return await canvasToPngBlob(canvas);
  } finally {
    URL.revokeObjectURL(svgObjectUrl);
  }
}

export function MaterialCardPreview({
  baseUrl,
  username,
  version,
}: MaterialCardAssetProps) {
  const t = useTranslations("badge");
  const { previewUrl } = useMaterialCardAsset({ baseUrl, username, version });

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={previewUrl}
      alt={t("materialAlt", { username })}
      className="w-full rounded-xl border border-white/10 bg-white/[0.02]"
    />
  );
}

export function MaterialCardSaveButton({
  baseUrl,
  username,
  version,
  surface,
  appearance = "panel",
}: MaterialCardAssetProps & {
  surface: "profile" | "modal";
  appearance?: "panel" | "pill";
}) {
  const t = useTranslations("badge");
  const tRoaster = useTranslations("roaster");
  const [savingPng, setSavingPng] = useState(false);
  const { previewUrl, fileStem } = useMaterialCardAsset({ baseUrl, username, version });

  const downloadPng = async () => {
    if (savingPng) return;
    setSavingPng(true);
    try {
      downloadBlob(await materialCardPng(previewUrl), `${fileStem}.png`);
      trackEvent("share_click", { channel: "advx_material_png", surface });
    } catch (error) {
      console.error("material card PNG download failed:", error);
    } finally {
      setSavingPng(false);
    }
  };

  return (
    <button
      type="button"
      onClick={downloadPng}
      disabled={savingPng}
      aria-busy={savingPng}
      className={
        appearance === "pill"
          ? "rounded-full bg-orange-600/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-orange-500 disabled:cursor-wait disabled:opacity-50"
          : "rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-500 disabled:cursor-wait disabled:opacity-60"
      }
    >
      {savingPng
        ? tRoaster("saving")
        : appearance === "pill"
          ? t("materialSave")
          : `↓ ${t("materialDownloadPng")}`}
    </button>
  );
}

export function MaterialCardPanel({
  baseUrl,
  username,
  version,
}: MaterialCardAssetProps) {
  const t = useTranslations("badge");
  const { previewUrl, fileStem } = useMaterialCardAsset({ baseUrl, username, version });

  return (
    <section className="bg-transparent p-0">
      <div className="mb-3">
        <h2 className="text-base font-bold text-zinc-200">{t("materialTitle")}</h2>
        <p className="mt-1 text-xs text-zinc-400">{t("materialBlurb")}</p>
      </div>
      <MaterialCardPreview baseUrl={baseUrl} username={username} version={version} />
      <div className="mt-4 flex flex-wrap gap-2">
        <MaterialCardSaveButton
          baseUrl={baseUrl}
          username={username}
          version={version}
          surface="profile"
        />
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
