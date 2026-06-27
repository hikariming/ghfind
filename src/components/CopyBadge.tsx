"use client";

import { useState } from "react";

// User-facing copy kept in one place so wiring i18n later only touches this object.
const T = {
  heading: "📌 把徽章贴到你的主页",
  blurb: "复制下面任意一段，贴进你的 GitHub Profile README，分数会自动保持最新。",
  markdown: "Markdown",
  html: "HTML",
  copy: "复制",
  copied: "已复制 ✓",
  alt: "GitHub Roast 评分徽章",
};

export function CopyBadge({ baseUrl, username }: { baseUrl: string; username: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  const base = baseUrl.replace(/\/$/, "");
  const badgeUrl = `${base}/api/badge/${username}`;
  const pageUrl = `${base}/u/${username}`;
  const markdown = `[![${T.alt}](${badgeUrl})](${pageUrl})`;
  const html = `<a href="${pageUrl}"><img src="${badgeUrl}" alt="${T.alt}" /></a>`;

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        <button
          onClick={() => copy(value, label)}
          className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/10"
        >
          {copied === label ? T.copied : T.copy}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[11px] leading-relaxed text-zinc-300">
        <code>{value}</code>
      </pre>
    </div>
  );

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
      <h2 className="text-base font-bold text-zinc-200">{T.heading}</h2>
      <p className="mt-1 text-xs text-zinc-500">{T.blurb}</p>

      <div className="mt-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={badgeUrl} alt={T.alt} className="h-5" />
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <Row label={T.markdown} value={markdown} />
        <Row label={T.html} value={html} />
      </div>
    </section>
  );
}
