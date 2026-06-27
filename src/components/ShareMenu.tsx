"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Platform = { key: string; label: string; color: string; href: (u: string, t: string) => string };

// Link-based platforms with web share intents. The link is the user's detail
// page, whose OG image is the flex card — so previews show the card.
const PLATFORMS: Platform[] = [
  { key: "x", label: "X", color: "#fff", href: (u, t) => `https://x.com/intent/tweet?text=${t}&url=${u}` },
  { key: "fb", label: "Facebook", color: "#60a5fa", href: (u) => `https://www.facebook.com/sharer/sharer.php?u=${u}` },
  { key: "li", label: "LinkedIn", color: "#38bdf8", href: (u) => `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
  { key: "wb", label: "微博", color: "#fb7185", href: (u, t) => `https://service.weibo.com/share/share.php?url=${u}&title=${t}` },
  { key: "tg", label: "Telegram", color: "#22d3ee", href: (u, t) => `https://t.me/share/url?url=${u}&text=${t}` },
  { key: "qz", label: "QQ空间", color: "#fcd34d", href: (u, t) => `https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url=${u}&title=${t}` },
];

export function ShareMenu({
  link,
  text,
  onShareImage,
}: {
  link: string;
  text: string;
  onShareImage: () => void;
}) {
  const T = useTranslations("share");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [canNative, setCanNative] = useState(false);

  useEffect(() => {
    setCanNative(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  const u = encodeURIComponent(link);
  const t = encodeURIComponent(text);

  const openIntent = (href: string) => {
    window.open(href, "_blank", "noopener,noreferrer,width=600,height=540");
    setOpen(false);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${text} ${link}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: T("siteName"), text, url: link });
    } catch {
      /* user cancelled / unsupported */
    }
    setOpen(false);
  };

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
      >
        {T("open")}
      </button>

      {open && (
        <>
          {/* backdrop closes the menu on outside click */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-1/2 z-50 mt-2 w-60 -translate-x-1/2 rounded-2xl border border-white/10 bg-zinc-900 p-3 shadow-2xl">
            <div className="mb-2 px-1 text-left text-xs font-medium text-zinc-500">{T("heading")}</div>
            <div className="grid grid-cols-3 gap-1.5">
              {PLATFORMS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => openIntent(p.href(u, t))}
                  className="rounded-lg border border-white/10 px-2 py-2 text-xs hover:bg-white/10"
                  style={{ color: p.color }}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <button
              onClick={() => {
                onShareImage();
                setOpen(false);
              }}
              className="mt-2 w-full rounded-lg border border-orange-400/30 bg-orange-500/10 px-2 py-2 text-xs font-medium text-orange-200 hover:bg-orange-500/20"
            >
              📷 {T("imageHint")}
            </button>

            <div className="mt-1.5 flex gap-1.5">
              <button
                onClick={copyLink}
                className="flex-1 rounded-lg border border-white/10 px-2 py-2 text-xs text-zinc-300 hover:bg-white/10"
              >
                📋 {copied ? T("copied") : T("copyLink")}
              </button>
              {canNative && (
                <button
                  onClick={nativeShare}
                  className="flex-1 rounded-lg border border-white/10 px-2 py-2 text-xs text-zinc-300 hover:bg-white/10"
                >
                  {T("native")}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
