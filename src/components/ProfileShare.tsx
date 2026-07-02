"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { TIER_KEY } from "@/lib/tier";
import type { Tags, Tier } from "@/lib/types";
import { SITE_URL } from "@/lib/site";
import { ShareCard } from "./ShareCard";
import { ShareCardExportHost } from "./ShareCardExportHost";
import { createShareCardBlob } from "./shareCardExport";
import { ShareMenu } from "./ShareMenu";

/**
 * Share affordances for a stored profile page (`/u/[username]`). The result page
 * (Roaster) has always had "save image / share", but profile pages — the URLs
 * that receive organic search + inbound-link traffic — only exposed the README
 * embed snippets. This closes the loop: a visitor who lands on someone's roast
 * from Google can re-share the flex card to X / 微博 / etc., turning SEO traffic
 * back into referral traffic. Purely additive; reuses {@link ShareCard}.
 */
export function ProfileShare({
  username,
  name,
  avatarUrl,
  score,
  tier,
  tierLabel,
  beat,
  tags,
}: {
  username: string;
  name: string | null;
  avatarUrl: string | null;
  score: number;
  tier: Tier;
  tierLabel: string;
  beat: number | null;
  tags: Tags;
}) {
  const t = useTranslations("roaster");
  const tTier = useTranslations("tiers");
  const locale = useLocale();
  const cardRef = useRef<HTMLDivElement>(null);
  const [savingImg, setSavingImg] = useState(false);

  const link = locale === "en" ? `${SITE_URL}/en/u/${username}` : `${SITE_URL}/u/${username}`;
  const beatText = beat == null ? "" : t("shareBeat", { beat: beat.toFixed(1) });
  const shareText = t("shareText", {
    score: score.toFixed(2),
    tier: tTier(`${TIER_KEY[tier]}.name`),
    tierLabel,
    beat: beatText,
  });

  const fileName = () => `github-roast-${username}.png`;

  const genCardBlob = async (): Promise<Blob | null> => {
    if (!cardRef.current) return null;
    return createShareCardBlob(cardRef.current);
  };

  const downloadBlob = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName();
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveImage = async () => {
    if (savingImg) return;
    setSavingImg(true);
    try {
      const blob = await genCardBlob();
      if (blob) downloadBlob(blob);
    } catch (e) {
      console.error("save image failed:", e);
    } finally {
      setSavingImg(false);
    }
  };

  // Mobile native share sheet gets the PNG directly (微信/小红书); elsewhere fall
  // back to a plain download.
  const shareImage = async () => {
    if (savingImg) return;
    setSavingImg(true);
    try {
      const blob = await genCardBlob();
      if (!blob) return;
      const file = new File([blob], fileName(), { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: shareText });
      } else {
        downloadBlob(blob);
      }
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") console.error("share image failed:", e);
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

      <ShareCardExportHost>
        <ShareCard
          ref={cardRef}
          username={username}
          name={name}
          avatarUrl={avatarUrl}
          score={score}
          tier={tier}
          tierLabel={tierLabel}
          beat={beat}
          tags={tags}
        />
      </ShareCardExportHost>
    </div>
  );
}
