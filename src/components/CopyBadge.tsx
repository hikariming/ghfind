"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";

// Stable no-op subscribe: the origin never changes after load, so we only need
// the server/client snapshot split (null on SSR, real origin once hydrated).
const subscribeNoop = () => () => {};
const getOriginSnapshot = () => window.location.origin;
const getOriginServerSnapshot = () => null;

/** One copyable snippet row. Declared at module scope (not inside render) so it
 *  keeps a stable identity and doesn't reset state on every parent render. */
function SnippetRow({
  label,
  value,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        <button
          onClick={onCopy}
          className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/10"
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-300">
        <code>{value}</code>
      </pre>
    </div>
  );
}

export function CopyBadge({
  baseUrl,
  username,
  version,
}: {
  baseUrl: string;
  username: string;
  /**
   * Cache-buster for the on-page previews. The card/badge images are served with
   * a long CDN cache (README/camo views stay cheap), so without this the preview
   * shown right after a re-score would keep displaying the stale PNG. Keying it on
   * the current score forces a fresh fetch so the on-page card updates in real
   * time. The copyable README snippets intentionally stay clean (no `?v`) — those
   * embeds refresh via the CDN window, which is acceptable off-site.
   */
  version?: string | number;
}) {
  const T = useTranslations("badge");
  const [copied, setCopied] = useState<string | null>(null);
  const previewOrigin = useSyncExternalStore(
    subscribeNoop,
    getOriginSnapshot,
    getOriginServerSnapshot,
  );

  const base = baseUrl.replace(/\/$/, "");
  const previewBase = (previewOrigin ?? base).replace(/\/$/, "");
  const pageUrl = `${base}/u/${username}`;
  const badgeUrl = `${base}/api/badge/${username}`;
  const cardUrl = `${base}/api/card/${username}`;
  const badgePreviewUrl = `${previewBase}/api/badge/${username}`;
  const cardPreviewUrl = `${previewBase}/api/card/${username}`;
  const v =
    version !== undefined && version !== null
      ? `?v=${encodeURIComponent(String(version))}`
      : "";
  const badgePreview = `${badgePreviewUrl}${v}`;
  const cardPreview = `${cardPreviewUrl}${v}`;

  const badgeAlt = T("badgeAlt");
  const cardAlt = T("cardAlt");
  const snippets = {
    badgeMd: `[![${badgeAlt}](${badgeUrl})](${pageUrl})`,
    badgeHtml: `<a href="${pageUrl}"><img src="${badgeUrl}" alt="${badgeAlt}" /></a>`,
    cardMd: `[![${cardAlt}](${cardUrl})](${pageUrl})`,
    cardHtml: `<a href="${pageUrl}"><img src="${cardUrl}" alt="${cardAlt}" width="600" /></a>`,
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
      <h2 className="text-base font-bold text-zinc-200">{T("heading")}</h2>
      <p className="mt-1 text-xs text-zinc-500">{T("blurb")}</p>

      {/* Small badge */}
      <div className="mt-5">
        <div className="mb-2 text-xs font-semibold text-zinc-300">{T("badgeTitle")}</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={badgePreview} alt={badgeAlt} className="h-5" />
        <div className="mt-3 flex flex-col gap-3">
          <SnippetRow
            label={T("markdown")}
            value={snippets.badgeMd}
            copied={copied === "badge-md"}
            onCopy={() => copy(snippets.badgeMd, "badge-md")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
          <SnippetRow
            label={T("html")}
            value={snippets.badgeHtml}
            copied={copied === "badge-html"}
            onCopy={() => copy(snippets.badgeHtml, "badge-html")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
        </div>
      </div>

      {/* Big flex card */}
      <div className="mt-6 border-t border-white/10 pt-5">
        <div className="mb-2 text-xs font-semibold text-zinc-300">{T("cardTitle")}</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={cardPreview}
          alt={cardAlt}
          className="w-full max-w-md rounded-xl border border-white/10"
        />
        <div className="mt-3 flex flex-col gap-3">
          <SnippetRow
            label={T("markdown")}
            value={snippets.cardMd}
            copied={copied === "card-md"}
            onCopy={() => copy(snippets.cardMd, "card-md")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
          <SnippetRow
            label={T("html")}
            value={snippets.cardHtml}
            copied={copied === "card-html"}
            onCopy={() => copy(snippets.cardHtml, "card-html")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
        </div>
      </div>
    </section>
  );
}
