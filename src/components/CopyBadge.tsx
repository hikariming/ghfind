"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";

// Stable no-op subscribe: the origin never changes after load, so we only need
// the server/client snapshot split (null on SSR, real origin once hydrated).
const subscribeNoop = () => () => {};
const getOriginSnapshot = () => window.location.origin;
const getOriginServerSnapshot = () => null;

type CardTheme = "dark" | "light";

const CARD_THEMES: CardTheme[] = ["dark", "light"];

function withQuery(url: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
}

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
      <pre
        className="overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-300 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.3)_transparent] data-[scrollbar=code] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/30 hover:[&::-webkit-scrollbar-thumb]:bg-white/40"
        data-scrollbar="code"
      >
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
  const versionParam =
    version !== undefined && version !== null
      ? String(version)
      : undefined;
  const badgePreview = withQuery(badgePreviewUrl, { v: versionParam });

  const badgeAlt = T("badgeAlt");
  const cardAlt = T("cardAlt");
  const cardUrls = Object.fromEntries(
    CARD_THEMES.map((theme) => [
      theme,
      {
        url: withQuery(cardUrl, { theme }),
        preview: withQuery(cardPreviewUrl, { theme, v: versionParam }),
      },
    ]),
  ) as Record<CardTheme, { url: string; preview: string }>;
  const snippets = {
    badgeMd: `[![${badgeAlt}](${badgeUrl})](${pageUrl})`,
    badgeHtml: `<a href="${pageUrl}"><img src="${badgeUrl}" alt="${badgeAlt}" /></a>`,
    cardDarkMd: `[![${cardAlt}](${cardUrls.dark.url})](${pageUrl})`,
    cardDarkHtml: `<a href="${pageUrl}"><img src="${cardUrls.dark.url}" alt="${cardAlt}" width="600" /></a>`,
    cardLightMd: `[![${cardAlt}](${cardUrls.light.url})](${pageUrl})`,
    cardLightHtml: `<a href="${pageUrl}"><img src="${cardUrls.light.url}" alt="${cardAlt}" width="600" /></a>`,
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
        <div className="grid gap-3 lg:grid-cols-2">
          {CARD_THEMES.map((theme) => (
            <figure key={theme} className="min-w-0">
              <figcaption className="mb-1 text-xs font-semibold text-zinc-400">
                {theme === "dark" ? T("cardDark") : T("cardLight")}
              </figcaption>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cardUrls[theme].preview}
                alt={`${cardAlt} ${theme}`}
                className="w-full rounded-xl border border-white/10 bg-white/[0.02]"
              />
            </figure>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-3">
          <SnippetRow
            label={`${T("markdown")} · ${T("cardDark")}`}
            value={snippets.cardDarkMd}
            copied={copied === "card-dark-md"}
            onCopy={() => copy(snippets.cardDarkMd, "card-dark-md")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
          <SnippetRow
            label={`${T("markdown")} · ${T("cardLight")}`}
            value={snippets.cardLightMd}
            copied={copied === "card-light-md"}
            onCopy={() => copy(snippets.cardLightMd, "card-light-md")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
          <SnippetRow
            label={`${T("html")} · ${T("cardDark")}`}
            value={snippets.cardDarkHtml}
            copied={copied === "card-dark-html"}
            onCopy={() => copy(snippets.cardDarkHtml, "card-dark-html")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
          <SnippetRow
            label={`${T("html")} · ${T("cardLight")}`}
            value={snippets.cardLightHtml}
            copied={copied === "card-light-html"}
            onCopy={() => copy(snippets.cardLightHtml, "card-light-html")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
        </div>
      </div>
    </section>
  );
}
