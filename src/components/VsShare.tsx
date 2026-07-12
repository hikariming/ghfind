"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { SITE_URL, localePath } from "@/lib/site";
import { trackEvent } from "@/lib/track";
import { VsShareCard, type VsSide } from "./VsShareCard";
import { createShareCardBlob } from "./shareCardExport";
import { ShareCardExportHost } from "./ShareCardExportHost";
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
  bucketLabel,
  verdictLine,
  adviceLine,
}: {
  a: VsSide;
  b: VsSide;
  winner: "a" | "b" | "tie";
  bucketLabel: string;
  verdictLine: string;
  adviceLine?: string;
}) {
  const t = useTranslations("vs");
  const locale = useLocale();
  const cardRef = useRef<HTMLDivElement>(null);
  const [savingImg, setSavingImg] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);

  const link = `${SITE_URL}${localePath(locale, `/vs/${a.username}/${b.username}`)}`;
  const shareText = t("shareText", { a: a.username, b: b.username });
  const fileName = () => `ghfind-vs-${a.username}-${b.username}.png`;

  // README embed of the server-rendered battle card — the vs analog of
  // CopyBadge. Canonical (locale-free) URLs so one snippet works for everyone;
  // ref=vscard keeps click-throughs attributable (camo strips the Referer).
  const embedAlt = `@${a.username} vs @${b.username} — GitHub Roast`;
  const embedMd = `[![${embedAlt}](${SITE_URL}/api/card/vs/${a.username}/${b.username})](${SITE_URL}/vs/${a.username}/${b.username}?ref=vscard)`;

  const copyEmbed = async () => {
    try {
      await navigator.clipboard.writeText(embedMd);
      trackEvent("badge_copy", { surface: "vs", format: "md" });
      setEmbedCopied(true);
      setTimeout(() => setEmbedCopied(false), 2000);
    } catch (e) {
      console.error("copy vs embed failed:", e);
    }
  };

  const genBlob = async (): Promise<Blob | null> => {
    if (!cardRef.current) return null;
    // Shared, stabilized export: waits for fonts + avatar decode + the
    // data-share-card-ready flag before cloning (see shareCardExport).
    return createShareCardBlob(cardRef.current);
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
      <button
        onClick={copyEmbed}
        className="rounded-full border border-orange-400/40 px-4 py-1.5 text-xs font-medium text-orange-200 transition hover:bg-orange-500/10"
      >
        {embedCopied ? t("embedCopied") : t("copyEmbed")}
      </button>
      <ShareMenu link={link} text={shareText} onShareImage={shareImage} />

      <ShareCardExportHost>
        <VsShareCard
          ref={cardRef}
          a={a}
          b={b}
          winner={winner}
          bucketLabel={bucketLabel}
          verdictLine={verdictLine}
          adviceLine={adviceLine}
        />
      </ShareCardExportHost>
    </div>
  );
}
