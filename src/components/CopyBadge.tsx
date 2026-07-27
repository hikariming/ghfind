"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import { normLang, type Lang } from "@/lib/lang";
import { MINI_CARD_SIZES } from "@/lib/mini-card-sizes";
import { trackEvent } from "@/lib/track";

// Stable no-op subscribe: the origin never changes after load, so we only need
// the server/client snapshot split (null on SSR, real origin once hydrated).
const subscribeNoop = () => () => {};
const getOriginSnapshot = () => window.location.origin;
const getOriginServerSnapshot = () => null;

/**
 * `auto` (mini card only) embeds a prefers-color-scheme block, so one URL reads
 * correctly in both GitHub themes. The 1200×630 PNG can't do that.
 */
type CardTheme = "auto" | "dark" | "light";

/**
 * The size axis, widest decision first. Users were reaching for the 1200×630
 * card because it was the builder's only card — it swallows a README — while the
 * 20px badge carries no evidence. `bars` is the default for that reason.
 */
const SIZES = ["badge", "bars", "radar", "strip", "large"] as const;
type Size = (typeof SIZES)[number];
type MiniSize = Extract<Size, "bars" | "radar" | "strip">;

const SIZE_KEY: Record<Size, string> = {
  badge: "sizeBadge",
  bars: "sizeMiniBars",
  radar: "sizeMiniRadar",
  strip: "sizeMiniStrip",
  large: "sizeLarge",
};

const LARGE_WIDTH = 600;

function isMini(size: Size): size is MiniSize {
  return size !== "badge" && size !== "large";
}

// Specialty variants of the large card. Keys map to `?variant=` (except `score`,
// which is the default) and to `<key>` i18n labels.
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

/** A labelled chip row. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      {children}
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
  surface = "unknown",
}: {
  baseUrl: string;
  username: string;
  /** Where this builder is mounted (e.g. "result", "profile") — attributes badge
   *  copies to the self-share vs. the on-landing viral loop in the funnel. */
  surface?: string;
  /**
   * Cache-buster for the on-page previews. The card/badge images are served with
   * a long CDN cache (README/camo views stay cheap), so without this the preview
   * shown right after a re-score would keep displaying the stale image. Keying it
   * on the current score forces a fresh fetch so the on-page card updates in real
   * time. The copyable README snippets intentionally stay clean (no `?v`) — those
   * embeds refresh via the CDN window, which is acceptable off-site.
   */
  version?: string | number;
}) {
  const T = useTranslations("badge");
  const locale = useLocale();
  const [copied, setCopied] = useState<string | null>(null);
  // Builder selections.
  const [size, setSize] = useState<Size>("bars");
  const [theme, setTheme] = useState<CardTheme>("auto");
  const [lang, setLang] = useState<Lang>(() => normLang(locale));
  const [type, setType] = useState<BuilderType>("score");
  const [qr, setQr] = useState(false);
  const previewOrigin = useSyncExternalStore(
    subscribeNoop,
    getOriginSnapshot,
    getOriginServerSnapshot,
  );

  const base = baseUrl.replace(/\/$/, "");
  const previewBase = (previewOrigin ?? base).replace(/\/$/, "");
  // Tag the copyable badge/card link so README click-throughs are attributable
  // (and trigger the badge-landing banner) independent of the Referer header,
  // which GitHub camo strips down to a bare origin. The canonical <link> on the
  // profile page still points at the clean /u/{username}, so no SEO duplicate.
  const pageUrl = `${base}/u/${username}?ref=badge`;
  const versionParam =
    version !== undefined && version !== null ? String(version) : undefined;

  // Only non-default params land in the URL — a clean link is the common case.
  const imageUrl = (
    origin: string,
    extra: Record<string, string | undefined> = {},
  ): string => {
    if (size === "badge") {
      return withQuery(`${origin}/api/badge/${username}`, {
        lang: lang === "zh" ? "zh" : undefined,
        ...extra,
      });
    }
    if (size === "large") {
      return withQuery(`${origin}/api/card/${username}`, {
        // The large card has no `auto`; the chip row hides it, but a stale
        // selection must never leak an unsupported value into a README.
        theme: theme === "auto" ? "dark" : theme,
        variant: type === "score" ? undefined : type,
        qr: qr ? "1" : undefined,
        ...extra,
      });
    }
    return withQuery(`${origin}/api/card/mini/${username}`, {
      variant: size === "bars" ? undefined : size,
      theme: theme === "auto" ? undefined : theme,
      lang: lang === "en" ? undefined : lang,
      ...extra,
    });
  };

  const alt = T(size === "badge" ? "badgeAlt" : isMini(size) ? "miniAlt" : "cardAlt");
  const url = imageUrl(base);
  const previewUrl = imageUrl(previewBase, { v: versionParam });
  const embedWidth = size === "large" ? LARGE_WIDTH : isMini(size) ? MINI_CARD_SIZES[size].w : null;
  const widthAttr = embedWidth ? ` width="${embedWidth}"` : "";

  const markdown = `[![${alt}](${url})](${pageUrl})`;
  const html = `<a href="${pageUrl}"><img src="${url}" alt="${alt}"${widthAttr} /></a>`;
  // `theme=auto` resolves against the viewer's OS, which is wrong for anyone who
  // pins a GitHub theme independently. <picture> is the escape hatch: GitHub
  // honors `media` on <source>, so each theme gets its own pinned URL.
  const picture = isMini(size)
    ? [
        `<a href="${pageUrl}">`,
        `  <picture>`,
        `    <source media="(prefers-color-scheme: dark)" srcset="${imageUrl(base, { theme: "dark" })}" />`,
        `    <img src="${imageUrl(base, { theme: "light" })}" alt="${alt}" width="${embedWidth}" />`,
        `  </picture>`,
        `</a>`,
      ].join("\n")
    : null;

  const sizeOptions = SIZES.map((s) => ({ key: s, label: T(SIZE_KEY[s]) }));
  const themeOptions: { key: CardTheme; label: string }[] = [
    ...(isMini(size) ? [{ key: "auto" as const, label: T("themeAuto") }] : []),
    { key: "dark", label: T("themeDark") },
    { key: "light", label: T("themeLight") },
  ];
  const langOptions: { key: Lang; label: string }[] = [
    { key: "en", label: T("langEn") },
    { key: "zh", label: T("langZh") },
  ];
  const typeOptions = BUILDER_TYPES.map((t) => ({ key: t, label: T(TYPE_KEY[t]) }));
  const qrOptions: { key: "on" | "off"; label: string }[] = [
    { key: "off", label: T("qrOff") },
    { key: "on", label: T("qrOn") },
  ];

  const changeSize = (next: Size) => {
    setSize(next);
    // The large card only renders dark/light.
    if (next === "large" && theme === "auto") setTheme("dark");
  };

  const copy = async (text: string, kind: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      // `kind` is `<size>-<snippet>` (badge-md / bars-html / …); low cardinality.
      trackEvent("badge_copy", { kind, surface });
      setTimeout(() => setCopied((c) => (c === kind ? null : c)), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  const snippets: { key: string; label: string; value: string }[] = [
    ...(size === "badge" ? [] : [{ key: "url", label: T("fieldUrl"), value: url }]),
    { key: "md", label: T("markdown"), value: markdown },
    { key: "html", label: T("html"), value: html },
    ...(picture ? [{ key: "picture", label: T("picture"), value: picture }] : []),
  ];

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
      <h2 className="text-base font-bold text-zinc-200">{T("heading")}</h2>
      <p className="mt-1 text-xs text-zinc-500">{T("blurb")}</p>

      <div className="mt-5 flex flex-col gap-4">
        <Field label={T("fieldSize")}>
          <ChipGroup options={sizeOptions} value={size} onChange={changeSize} />
        </Field>

        <div className="flex flex-wrap gap-x-8 gap-y-4">
          {size !== "badge" && (
            <Field label={T("fieldTheme")}>
              <ChipGroup options={themeOptions} value={theme} onChange={setTheme} />
            </Field>
          )}
          {size !== "large" && (
            <Field label={T("fieldLang")}>
              <ChipGroup options={langOptions} value={lang} onChange={setLang} />
            </Field>
          )}
          {size === "large" && (
            <Field label={T("fieldQr")}>
              <ChipGroup
                options={qrOptions}
                value={qr ? "on" : "off"}
                onChange={(v) => setQr(v === "on")}
              />
            </Field>
          )}
        </div>

        {size === "large" && (
          <Field label={T("fieldType")}>
            <ChipGroup options={typeOptions} value={type} onChange={setType} />
          </Field>
        )}

        {isMini(size) && <p className="text-[11px] leading-relaxed text-zinc-500">{T("miniHint")}</p>}
      </div>

      {/* Live preview. The mini card is pinned to its intrinsic width — stretching
          a 440px card to the container misrepresents how it lands in a README. */}
      <figure className="mt-4 min-w-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={previewUrl}
          alt={alt}
          className={
            size === "badge"
              ? "h-5"
              : "rounded-xl border border-white/10 bg-white/[0.02]"
          }
          style={
            isMini(size)
              ? { width: MINI_CARD_SIZES[size].w, maxWidth: "100%" }
              : size === "large"
                ? { width: "100%" }
                : undefined
          }
        />
      </figure>

      {/* Generated snippets for the current selection */}
      <div className="mt-3 flex flex-col gap-3">
        {snippets.map((s) => {
          const kind = `${size}-${s.key}`;
          return (
            <SnippetRow
              key={s.key}
              label={s.label}
              value={s.value}
              copied={copied === kind}
              onCopy={() => copy(s.value, kind)}
              copyLabel={T("copy")}
              copiedLabel={T("copied")}
            />
          );
        })}
      </div>
    </section>
  );
}
