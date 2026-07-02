"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";

// Stable no-op subscribe: the origin never changes after load, so we only need
// the server/client snapshot split (null on SSR, real origin once hydrated).
const subscribeNoop = () => () => {};
const getOriginSnapshot = () => window.location.origin;
const getOriginServerSnapshot = () => null;

type CardTheme = "dark" | "light";

// Card types offered by the builder. `score` is the classic tier card; the rest
// are the specialty "brag cards". Keys map to `?variant=` (except `score`, which
// is the default) and to `<key>` i18n labels.
const BUILDER_TYPES = ["score", "contrib", "pr", "path", "work"] as const;
type BuilderType = (typeof BUILDER_TYPES)[number];
const TYPE_KEY: Record<BuilderType, string> = {
  score: "typeScore",
  contrib: "variantContrib",
  pr: "variantPr",
  path: "variantPath",
  work: "variantWork",
};

function withQuery(url: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `${url}?${qs}` : url;
}

/** A row of mutually-exclusive selectable chips. Module scope so it keeps a
 *  stable identity across parent renders. */
function ChipGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
            value === o.key
              ? "border-orange-400/50 bg-orange-500/15 text-orange-200"
              : "border-white/10 text-zinc-400 hover:bg-white/5"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
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
  // Builder selections.
  const [type, setType] = useState<BuilderType>("score");
  const [theme, setTheme] = useState<CardTheme>("dark");
  const [qr, setQr] = useState(false);
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
    version !== undefined && version !== null ? String(version) : undefined;
  const badgePreview = withQuery(badgePreviewUrl, { v: versionParam });

  const badgeAlt = T("badgeAlt");
  const cardAlt = T("cardAlt");
  const badgeMd = `[![${badgeAlt}](${badgeUrl})](${pageUrl})`;
  const badgeHtml = `<a href="${pageUrl}"><img src="${badgeUrl}" alt="${badgeAlt}" /></a>`;

  // Builder → the query params selected right now. `variant` is omitted for the
  // default score card; `qr` only when toggled on — keeps clean URLs the common case.
  const cardParams: Record<string, string | undefined> = { theme };
  if (type !== "score") cardParams.variant = type;
  if (qr) cardParams.qr = "1";
  const cardCurrentUrl = withQuery(cardUrl, cardParams);
  const cardCurrentPreview = withQuery(cardPreviewUrl, { ...cardParams, v: versionParam });
  const builderMd = `[![${cardAlt}](${cardCurrentUrl})](${pageUrl})`;
  const builderHtml = `<a href="${pageUrl}"><img src="${cardCurrentUrl}" alt="${cardAlt}" width="600" /></a>`;

  const typeOptions = BUILDER_TYPES.map((t) => ({ key: t, label: T(TYPE_KEY[t]) }));
  const themeOptions: { key: CardTheme; label: string }[] = [
    { key: "dark", label: T("themeDark") },
    { key: "light", label: T("themeLight") },
  ];
  const qrOptions: { key: "on" | "off"; label: string }[] = [
    { key: "off", label: T("qrOff") },
    { key: "on", label: T("qrOn") },
  ];

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
            value={badgeMd}
            copied={copied === "badge-md"}
            onCopy={() => copy(badgeMd, "badge-md")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
          <SnippetRow
            label={T("html")}
            value={badgeHtml}
            copied={copied === "badge-html"}
            onCopy={() => copy(badgeHtml, "badge-html")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
        </div>
      </div>

      {/* Card builder */}
      <div className="mt-6 border-t border-white/10 pt-5">
        <div className="mb-1 text-xs font-semibold text-zinc-300">{T("builderTitle")}</div>
        <p className="mb-4 text-xs text-zinc-500">{T("builderBlurb")}</p>

        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              {T("fieldType")}
            </div>
            <ChipGroup options={typeOptions} value={type} onChange={setType} />
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                {T("fieldTheme")}
              </div>
              <ChipGroup options={themeOptions} value={theme} onChange={setTheme} />
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                {T("fieldQr")}
              </div>
              <ChipGroup
                options={qrOptions}
                value={qr ? "on" : "off"}
                onChange={(v) => setQr(v === "on")}
              />
            </div>
          </div>
        </div>

        {/* Live preview */}
        <figure className="mt-4 min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cardCurrentPreview}
            alt={cardAlt}
            className="w-full rounded-xl border border-white/10 bg-white/[0.02]"
          />
        </figure>

        {/* Generated snippets for the current selection */}
        <div className="mt-3 flex flex-col gap-3">
          <SnippetRow
            label={T("fieldUrl")}
            value={cardCurrentUrl}
            copied={copied === "builder-url"}
            onCopy={() => copy(cardCurrentUrl, "builder-url")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
          <SnippetRow
            label={T("markdown")}
            value={builderMd}
            copied={copied === "builder-md"}
            onCopy={() => copy(builderMd, "builder-md")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
          <SnippetRow
            label={T("html")}
            value={builderHtml}
            copied={copied === "builder-html"}
            onCopy={() => copy(builderHtml, "builder-html")}
            copyLabel={T("copy")}
            copiedLabel={T("copied")}
          />
        </div>
      </div>
    </section>
  );
}
