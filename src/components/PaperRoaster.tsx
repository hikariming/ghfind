"use client";

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "@/i18n/navigation";
import { PAPER_DIM_KEYS, paperTierStyle } from "@/lib/paper-score";
import type { PaperData, PaperDims, PaperMeta, PaperMode } from "@/lib/paper-types";
import { ByoKeyConfig, ByoKeyModal, loadByoKey } from "./ByoKeyModal";

interface Locked {
  score: number;
  dims: PaperDims;
}

export function PaperRoaster() {
  const t = useTranslations("paper");
  const tTier = useTranslations("paperTiers");
  const locale = useLocale();

  const [input, setInput] = useState("");
  const [mode, setMode] = useState<PaperMode>("roast");
  const [scanning, setScanning] = useState(false);
  const [roasting, setRoasting] = useState(false);
  const [paper, setPaper] = useState<PaperData | null>(null);
  const [meta, setMeta] = useState<PaperMeta | null>(null);
  const [report, setReport] = useState("");
  const [locked, setLocked] = useState<Locked | null>(null);
  const [error, setError] = useState("");
  const [byoOpen, setByoOpen] = useState(false);
  const [byoReason, setByoReason] = useState<string | undefined>();

  const runRoast = useCallback(
    async (p: PaperData, m: PaperMode, lock: Locked | null) => {
      setRoasting(true);
      setReport("");
      if (!lock) setMeta(null);
      const byoKey: ByoKeyConfig | null = loadByoKey();
      try {
        const res = await fetch("/api/paper/roast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paper: p, mode: m, lang: locale, byoKey, locked: lock ?? undefined }),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          if (data?.useByoKey) {
            setByoReason(data.error === "llm_quota" ? t("byoReasonQuota") : t("byoReasonRate"));
            setByoOpen(true);
            setRoasting(false);
            return;
          }
          setError(t("errRoastFailed"));
          setRoasting(false);
          return;
        }
        const metaHeader = res.headers.get("X-Paper-Meta");
        if (metaHeader) {
          try {
            const json = new TextDecoder().decode(Uint8Array.from(atob(metaHeader), (c) => c.charCodeAt(0)));
            const pm = JSON.parse(json) as PaperMeta;
            setMeta(pm);
            if (!lock) setLocked({ score: pm.final_score, dims: pm.dims });
          } catch {
            /* keep prior meta */
          }
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setReport(acc);
        }
      } catch {
        setError(t("errNetwork"));
      } finally {
        setRoasting(false);
      }
    },
    [locale, t],
  );

  const submit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (scanning || roasting) return;
      if (!input.trim()) {
        setError(t("errEmpty"));
        return;
      }
      setError("");
      setPaper(null);
      setMeta(null);
      setReport("");
      setLocked(null);
      setScanning(true);
      try {
        const res = await fetch("/api/paper/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: input.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(
            data?.error === "invalid_arxiv"
              ? t("errInvalid")
              : data?.error === "paper_not_found"
                ? t("errNotFound")
                : t("errScanFailed"),
          );
          setScanning(false);
          return;
        }
        const p = data as PaperData;
        setPaper(p);
        setScanning(false);
        void runRoast(p, mode, null);
      } catch {
        setError(t("errNetwork"));
        setScanning(false);
      }
    },
    [input, scanning, roasting, mode, runRoast, t],
  );

  // Switching tone reuses the locked (fixed) score so the number never wobbles.
  const switchMode = (m: PaperMode) => {
    if (m === mode || roasting) return;
    setMode(m);
    if (paper && locked) void runRoast(paper, m, locked);
  };

  const style = meta ? paperTierStyle(meta.tier) : null;
  const tldr = meta ? (locale === "en" ? meta.tldr_line.en : meta.tldr_line.zh) : "";

  return (
    <div className="w-full max-w-2xl">
      <form onSubmit={submit} className="flex flex-col items-center gap-3">
        <div className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-1.5 focus-within:border-orange-500/60">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("inputPlaceholder")}
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-base outline-none placeholder:text-zinc-600"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={scanning || roasting}
            className="shrink-0 whitespace-nowrap rounded-lg bg-orange-600 px-5 py-2 font-medium text-white transition hover:bg-orange-500 disabled:opacity-60"
          >
            {scanning ? t("judging") : t("judge")}
          </button>
        </div>

        {/* Tone toggle */}
        <div className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1 text-sm font-bold">
          {(["roast", "praise"] as PaperMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`rounded-full px-3 py-1.5 transition-colors ${
                mode === m ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {m === "roast" ? t("modeRoast") : t("modePraise")}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            setByoReason(undefined);
            setByoOpen(true);
          }}
          className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
        >
          {t("byoLink")}
        </button>
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </form>

      {scanning && (
        <div className="mt-10 animate-pulse text-center text-zinc-500">{t("scanning")}</div>
      )}

      {paper && (
        <div className="mt-8">
          {/* Score card */}
          <div
            className={`animate-pop flex flex-col items-center rounded-2xl border bg-white/[0.03] p-6 text-center ring-1 ${style?.ring ?? "ring-white/10"}`}
            style={style ? { boxShadow: `0 0 80px -20px ${style.glow}` } : undefined}
          >
            <a
              href={`https://arxiv.org/abs/${paper.arxiv_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="max-w-full text-balance text-lg font-bold leading-snug text-zinc-100 hover:text-white"
            >
              {paper.title}
            </a>
            <div className="mt-1 max-w-full truncate text-xs text-zinc-500">
              {paper.authors.slice(0, 4).join(", ")}
              {paper.authors.length > 4 ? " et al." : ""}
            </div>

            {meta && style ? (
              <>
                <div className={`mt-5 text-6xl font-black tabular-nums ${style.text}`}>
                  {meta.final_score.toFixed(2)}
                  <span className="text-2xl text-zinc-600">/100</span>
                </div>
                <div className={`mt-1 text-2xl font-bold ${style.text}`}>
                  {style.emoji} {tTier(`${meta.tier}.name`)}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {t("contentScore")} {meta.content_base.toFixed(1)} · {t("citationBonus")} +
                  {meta.citation_bonus.toFixed(1)}
                  {" · "}
                  {paper.citation_count !== null
                    ? t("citations", { n: paper.citation_count })
                    : t("noCitations")}
                </div>
                {tldr && (
                  <p className="mt-4 w-full rounded-xl border border-orange-500/20 bg-orange-500/[0.04] p-3 text-left text-sm leading-relaxed text-zinc-100">
                    💡 {tldr}
                  </p>
                )}
                {(meta.tags.zh.length > 0 || meta.tags.en.length > 0) && (
                  <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                    {[...meta.tags.zh, ...meta.tags.en].map((tag, i) => (
                      <span
                        key={`${tag}-${i}`}
                        className="rounded-full border border-orange-400/30 bg-orange-500/10 px-2.5 py-0.5 text-xs font-medium text-orange-200"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                {!roasting && (
                  <Link
                    href={`/arxiv/${paper.arxiv_id}`}
                    prefetch={false}
                    className="mt-4 text-xs text-orange-400 underline-offset-2 hover:underline"
                  >
                    {t("permalink")}
                  </Link>
                )}
              </>
            ) : (
              <div className="mt-6 flex gap-1.5 py-4">
                <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400 [animation-delay:-0.3s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400 [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400" />
              </div>
            )}
          </div>

          {/* Dimension bars */}
          {meta && (
            <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
              <h2 className="mb-4 text-base font-bold text-zinc-200">{t("dimsHeading")}</h2>
              <div className="flex flex-col gap-3">
                {PAPER_DIM_KEYS.map((key) => {
                  const v = meta.dims[key] ?? 0;
                  const pct = Math.max(0, Math.min(1, v / 10));
                  return (
                    <div key={key}>
                      <div className="mb-1 flex items-baseline justify-between text-sm">
                        <span className="text-zinc-300">{t(`dim_${key}`)}</span>
                        <span className="tabular-nums text-zinc-400">
                          {v.toFixed(1)}
                          <span className="text-zinc-600"> / 10</span>
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className={`h-full rounded-full ${pct >= 0.75 ? "bg-emerald-400" : pct >= 0.45 ? "bg-amber-400" : "bg-rose-400"}`}
                          style={{ width: `${pct * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Commentary */}
          <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-7">
            <h2 className="mb-3 text-lg font-bold text-orange-400">
              {mode === "roast" ? t("commentaryRoast") : t("commentaryPraise")}
            </h2>
            {report ? (
              <div className={`report text-[0.95rem] text-zinc-200 ${roasting ? "caret" : ""}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">{roasting ? t("thinking") : t("pending")}</p>
            )}
          </section>
        </div>
      )}

      <ByoKeyModal
        open={byoOpen}
        reason={byoReason}
        onClose={() => setByoOpen(false)}
        onSave={(cfg) => {
          setByoOpen(false);
          if (cfg && paper) void runRoast(paper, mode, locked);
        }}
      />
    </div>
  );
}
