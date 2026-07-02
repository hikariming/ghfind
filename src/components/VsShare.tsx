"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { SITE_URL } from "@/lib/site";
import { VsShareCard, type VsSide } from "./VsShareCard";
import { ShareMenu } from "./ShareMenu";

/**
 * Save / share the PK result as a big flex image (the "炫耀大图"), mirroring
 * {@link ProfileShare}: renders {@link VsShareCard} off-screen and exports it to
 * PNG via html-to-image, then hands it to the native share sheet or downloads it.
 * Complements the server OG card (which drives link previews).
 */
export function VsShare({
  a,
  b,
  winner,
  verdictLine,
}: {
  a: VsSide;
  b: VsSide;
  winner: "a" | "b" | "tie";
  verdictLine: string;
}) {
  const t = useTranslations("vs");
  const locale = useLocale();
  const cardRef = useRef<HTMLDivElement>(null);
  const [savingImg, setSavingImg] = useState(false);

  const link =
    locale === "en"
      ? `${SITE_URL}/en/vs/${a.username}/${b.username}`
      : `${SITE_URL}/vs/${a.username}/${b.username}`;
  const shareText = t("shareText", { a: a.username, b: b.username });
  const fileName = () => `ghfind-vs-${a.username}-${b.username}.png`;

  const genBlob = async (): Promise<Blob | null> => {
    if (!cardRef.current) return null;
    const { toBlob } = await import("html-to-image");
    return toBlob(cardRef.current, { pixelRatio: 2, cacheBust: true });
  };

  const downloadBlob = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = fileName();
    el.click();
    URL.revokeObjectURL(url);
  };

  const saveImage = async () => {
    if (savingImg) return;
    setSavingImg(true);
    try {
      const blob = await genBlob();
      if (blob) downloadBlob(blob);
    } catch (e) {
      console.error("save vs image failed:", e);
    } finally {
      setSavingImg(false);
    }
  };

  const shareImage = async () => {
    if (savingImg) return;
    setSavingImg(true);
    try {
      const blob = await genBlob();
      if (!blob) return;
      const file = new File([blob], fileName(), { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: shareText });
      } else {
        downloadBlob(blob);
      }
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") console.error("share vs image failed:", e);
    } finally {
      setSavingImg(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <button
        onClick={saveImage}
        disabled={savingImg}
        className="rounded-full bg-orange-600/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-50"
      >
        {savingImg ? t("saving") : t("saveImage")}
      </button>
      <ShareMenu link={link} text={shareText} onShareImage={shareImage} />

      {/* Off-screen export target */}
      <div className="pointer-events-none fixed -left-[9999px] top-0">
        <VsShareCard ref={cardRef} a={a} b={b} winner={winner} verdictLine={verdictLine} />
      </div>
    </div>
  );
}
