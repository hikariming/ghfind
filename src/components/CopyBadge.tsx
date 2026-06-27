"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

export function CopyBadge({ baseUrl, username }: { baseUrl: string; username: string }) {
  const T = useTranslations("badge");
  const [copied, setCopied] = useState<string | null>(null);

  const base = baseUrl.replace(/\/$/, "");
  const pageUrl = `${base}/u/${username}`;
  const badgeUrl = `${base}/api/badge/${username}`;
  const cardUrl = `${base}/api/card/${username}`;

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

  const Row = ({ label, value, k }: { label: string; value: string; k: string }) => (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        <button
          onClick={() => copy(value, k)}
          className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/10"
        >
          {copied === k ? T("copied") : T("copy")}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-300">
        <code>{value}</code>
      </pre>
    </div>
  );

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
      <h2 className="text-base font-bold text-zinc-200">{T("heading")}</h2>
      <p className="mt-1 text-xs text-zinc-500">{T("blurb")}</p>

      {/* Small badge */}
      <div className="mt-5">
        <div className="mb-2 text-xs font-semibold text-zinc-300">{T("badgeTitle")}</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={badgeUrl} alt={badgeAlt} className="h-5" />
        <div className="mt-3 flex flex-col gap-3">
          <Row label={T("markdown")} value={snippets.badgeMd} k="badge-md" />
          <Row label={T("html")} value={snippets.badgeHtml} k="badge-html" />
        </div>
      </div>

      {/* Big flex card */}
      <div className="mt-6 border-t border-white/10 pt-5">
        <div className="mb-2 text-xs font-semibold text-zinc-300">{T("cardTitle")}</div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={cardUrl}
          alt={cardAlt}
          className="w-full max-w-md rounded-xl border border-white/10"
        />
        <div className="mt-3 flex flex-col gap-3">
          <Row label={T("markdown")} value={snippets.cardMd} k="card-md" />
          <Row label={T("html")} value={snippets.cardHtml} k="card-html" />
        </div>
      </div>
    </section>
  );
}
