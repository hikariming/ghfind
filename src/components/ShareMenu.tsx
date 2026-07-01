"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import { Camera, Clipboard, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Whether the browser supports the native Web Share API. Read via
 *  useSyncExternalStore so SSR sees `false` and the client reads the real value
 *  after hydration — no setState-in-effect, no hydration mismatch. */
const subscribeNoop = () => () => {};
const getCanNative = () =>
  typeof navigator !== "undefined" && typeof navigator.share === "function";

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
  const canNative = useSyncExternalStore(subscribeNoop, getCanNative, () => false);

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
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" shape="pill" className="px-4 py-1.5 text-xs">
          <Share2 className="h-3.5 w-3.5" />
          {T("open")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="w-60 border-white/10 bg-zinc-900 p-3"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel className="px-1 text-left text-xs font-medium text-zinc-500">
          {T("heading")}
        </DropdownMenuLabel>
        <div className="grid grid-cols-3 gap-1.5 p-1">
          {PLATFORMS.map((p) => (
            <Button
              key={p.key}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto border-white/10 px-2 py-2 text-xs hover:bg-white/10"
              style={{ color: p.color }}
              onClick={() => openIntent(p.href(u, t))}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <DropdownMenuSeparator className="my-2 bg-white/10" />
        <DropdownMenuItem
          className="rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-2 text-xs font-medium text-orange-200 focus:bg-orange-500/20 focus:text-orange-100"
          onSelect={(event) => {
            event.preventDefault();
            onShareImage();
            setOpen(false);
          }}
        >
          <Camera className="h-3.5 w-3.5" />
          {T("imageHint")}
        </DropdownMenuItem>

        <div className="mt-2 flex gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1 border-white/10 text-xs"
            onClick={copyLink}
          >
            <Clipboard className="h-3.5 w-3.5" />
            {copied ? T("copied") : T("copyLink")}
          </Button>
          {canNative && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1 border-white/10 text-xs"
              onClick={nativeShare}
            >
              {T("native")}
            </Button>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
