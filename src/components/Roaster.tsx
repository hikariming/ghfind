"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitReport } from "@/lib/report";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import type { RoastLine, RoastMeta, ScanResult, Tags, Tier } from "@/lib/types";
import {
  ByoKeyConfig,
  ByoKeyModal,
  loadByoKey,
} from "./ByoKeyModal";
import { CopyBadge } from "./CopyBadge";
import { ShareMenu } from "./ShareMenu";
import { SponsorPill } from "./Sponsor";
import { ShareCard } from "./ShareCard";
import { TierAvatarFrame } from "./TierAvatarFrame";
import { Turnstile, turnstileEnabled } from "./Turnstile";
import { SITE_URL } from "@/lib/site";

interface Display {
  score: number;
  tier: Tier;
  tierLabel: string;
  delta: number;
}

export function Roaster() {
  const t = useTranslations("roaster");
  const tScan = useTranslations("scanErrors");
  const tTier = useTranslations("tiers");
  const locale = useLocale();

  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const [roasting, setRoasting] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [byoOpen, setByoOpen] = useState(false);
  const [byoReason, setByoReason] = useState<string | undefined>();
  const [percentile, setPercentile] = useState<{ beat: number | null; total: number } | null>(
    null,
  );
  const [display, setDisplay] = useState<Display | null>(null);
  const [tags, setTags] = useState<Tags | null>(null);
  // Bilingual one-liner from the X-Roast-Meta header (arrives before the body
  // streams). The card shows the side matching the current locale.
  const [metaRoast, setMetaRoast] = useState<RoastLine | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const runRoast = useCallback(
    async (scanResult: ScanResult) => {
      setRoasting(true);
      setReport("");
      setMetaRoast(null);
      const byoKey: ByoKeyConfig | null = loadByoKey();
      try {
        const res = await fetch("/api/roast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `lang` selects the English vs Chinese prompt + per-language cache.
          body: JSON.stringify({ scan: scanResult, byoKey, lang: locale }),
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          if (data?.useByoKey) {
            setByoReason(
              data.error === "llm_quota"
                ? t("byoReasonQuota")
                : data.error === "rate_limited"
                  ? t("byoReasonRate")
                  : t("byoReasonDefault"),
            );
            setByoOpen(true);
            setRoasting(false);
            return;
          }
          setError(t("errRoastFailed"));
          setRoasting(false);
          return;
        }

        // The AI-adjusted score + percentile arrive as a header (base64 JSON), so
        // the streamed body is pure markdown — no in-band parsing to get wrong.
        const metaHeader = res.headers.get("X-Roast-Meta");
        if (metaHeader) {
          try {
            const json = new TextDecoder().decode(
              Uint8Array.from(atob(metaHeader), (c) => c.charCodeAt(0)),
            );
            const meta = JSON.parse(json) as RoastMeta;
            setDisplay({
              score: meta.final_score,
              tier: meta.tier,
              tierLabel: meta.tier_label,
              delta: meta.delta,
            });
            setPercentile(meta.percentile);
            if (meta.tags && (meta.tags.zh.length || meta.tags.en.length)) setTags(meta.tags);
            if (meta.roast_line && (meta.roast_line.zh || meta.roast_line.en))
              setMetaRoast(meta.roast_line);
          } catch {
            /* malformed meta — keep the deterministic display */
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
        setError(t("errNetworkRoast"));
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
      if (!username.trim()) {
        setError(t("errEmpty"));
        return;
      }
      if (turnstileEnabled() && !token) {
        setError(t("errNeedTurnstile"));
        return;
      }
      setError("");
      setScan(null);
      setReport("");
      setPercentile(null);
      setDisplay(null);
      setTags(null);
      setMetaRoast(null);
      setScanning(true);
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username.trim(), turnstileToken: token }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(tScan.has(data?.error) ? tScan(data.error) : t("errScanFailed"));
          setScanning(false);
          return;
        }
        const result = data as ScanResult;
        setScan(result);
        // Show the deterministic score immediately; the roast's META line then
        // updates it to the AI-adjusted final.
        setDisplay({
          score: result.scoring.final_score,
          tier: result.scoring.tier,
          tierLabel: result.scoring.tier_label,
          delta: 0,
        });
        setScanning(false);
        void runRoast(result);
        setTimeout(
          () => reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
          100,
        );
      } catch {
        setError(t("errNetworkScan"));
        setScanning(false);
      }
    },
    [username, token, scanning, roasting, runRoast, t, tScan],
  );

  const beatValue = percentile?.beat == null ? null : percentile.beat.toFixed(1);
  const beatText = beatValue !== null ? t("shareBeat", { beat: beatValue }) : "";
  const shareText =
    scan && display
      ? t("shareText", {
          score: display.score.toFixed(2),
          tier: tTier(`${TIER_KEY[display.tier]}.name`),
          tierLabel: display.tierLabel,
          beat: beatText,
          siteUrl: SITE_URL.replace(/^https?:\/\//, ""),
        })
      : "";

  const style = display ? tierStyle(display.tier) : null;
  // The one-liner now rides the meta header (bilingual, shown in the current
  // locale). Fall back to splitReport for legacy cached reports that still carry
  // the inline 🔥 marker; either way the body renders without that line.
  const { body: reportBody, roast: inlineRoast } = splitReport(report);
  const roastLine = (metaRoast ? (locale === "en" ? metaRoast.en : metaRoast.zh) : "") || inlineRoast;
  const cardRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const [savingImg, setSavingImg] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);

  // Copy the GitHub-embeddable card snippet, then scroll to the preview section.
  const copyCardEmbed = async () => {
    const u = scan?.metrics.username;
    if (!u) return;
    const md = `[![GitHub Roast](${SITE_URL}/api/card/${u})](${SITE_URL}/u/${u})`;
    try {
      await navigator.clipboard.writeText(md);
      setEmbedCopied(true);
      setTimeout(() => setEmbedCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
    badgeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const fileName = () => `github-roast-${scan?.metrics.username ?? "score"}.png`;

  const genCardBlob = async (): Promise<Blob | null> => {
    if (!cardRef.current) return null;
    const { toBlob } = await import("html-to-image");
    return toBlob(cardRef.current, { pixelRatio: 2, cacheBust: true });
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
    if (!cardRef.current || savingImg) return;
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

  // For 微信 / 小红书: hand the card PNG to the native share sheet on mobile
  // (pick the app, post the image); fall back to a plain download elsewhere.
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
    <div className="w-full max-w-4xl">
      {/* Input */}
      <form onSubmit={submit} className="flex flex-col items-center gap-3">
        <div className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-1.5 focus-within:border-orange-500/60">
          <span className="pl-3 text-zinc-500">@</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("inputPlaceholder")}
            className="min-w-0 flex-1 bg-transparent px-1 py-2 text-base outline-none placeholder:text-zinc-600"
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
        <Turnstile onToken={setToken} />
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </form>

      <div className="mt-3 flex flex-col items-center gap-3">
        <SponsorPill large />
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
      </div>

      {/* Scanning skeleton */}
      {scanning && (
        <div className="mt-10 animate-pulse text-center text-zinc-500">
          {t("scanning", { username })}
        </div>
      )}

      {/* Score reveal */}
      {scan && display && style && (
        <div ref={reportRef} className="mt-10">
          <div
            className={`animate-pop mx-auto flex max-w-md flex-col items-center rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center ring-1 ${style.ring}`}
            style={{ boxShadow: `0 0 80px -20px ${style.glow}` }}
          >
            <a
              href={scan.metrics.profile_url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className={`max-w-full break-all rounded-full bg-black/35 px-4 py-1.5 text-xl font-black leading-tight ${style.text} ring-1 ${style.ring} hover:bg-black/45`}
              style={{ boxShadow: `0 0 28px -10px ${style.glow}` }}
            >
              @{scan.metrics.username}
            </a>
            <TierAvatarFrame
              username={scan.metrics.username}
              avatarUrl={scan.metrics.avatar_url}
              tier={display.tier}
              size="lg"
              className="mt-5"
            />
            <div className={`mt-4 text-6xl font-black tabular-nums ${style.text}`}>
              {display.score.toFixed(2)}
              <span className="text-2xl text-zinc-600">/100</span>
            </div>
            <div className={`mt-1 text-2xl font-bold ${style.text}`}>
              {style.emoji} {tTier(`${TIER_KEY[display.tier]}.name`)}
            </div>

            {/* Savage one-liner only — full scoring report renders below the card */}
            <div className="mt-4 w-full rounded-xl border border-orange-500/20 bg-orange-500/[0.04] p-4 text-left">
              <div className="mb-2 text-base font-bold text-orange-400">{t("roastLabel")}</div>
              {roastLine ? (
                <p
                  className={`text-sm leading-relaxed text-zinc-100 ${
                    roasting && !reportBody ? "caret" : ""
                  }`}
                >
                  {roastLine}
                </p>
              ) : (
                <div className="flex flex-col items-center gap-3 py-3 text-center">
                  <div className="flex gap-1.5">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400 [animation-delay:-0.3s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400 [animation-delay:-0.15s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-orange-400" />
                  </div>
                  <div className="text-sm text-zinc-400">
                    {roasting ? t("roastThinking") : t("roastPending")}
                  </div>
                </div>
              )}

              {tags && (tags.zh.length > 0 || tags.en.length > 0) && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/10 pt-3">
                  {[...tags.zh, ...tags.en].map((tag, i) => (
                    <span
                      key={`${tag}-${i}`}
                      className="rounded-full border border-orange-400/30 bg-orange-500/10 px-2.5 py-0.5 text-xs font-medium text-orange-200"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {percentile &&
              (percentile.beat === null ? (
                <div className="mt-3 text-sm text-zinc-300">{t("firstJudged")}</div>
              ) : (
                <div className="mt-3 text-sm">
                  {t.rich("beatLine", {
                    beat: percentile.beat.toFixed(1),
                    total: percentile.total,
                    hl: (c) => <span className={`font-semibold ${style.text}`}>{c}</span>,
                    muted: (c) => <span className="text-zinc-400">{c}</span>,
                  })}
                </div>
              ))}

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={saveImage}
                disabled={savingImg}
                className="rounded-full bg-orange-600/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-50"
              >
                {savingImg ? t("saving") : t("saveImage")}
              </button>
              <button
                onClick={copyCardEmbed}
                className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
              >
                {embedCopied ? t("copied") : t("pasteGithub")}
              </button>
              <ShareMenu
                link={
                  loadByoKey()
                    ? SITE_URL
                    : `${SITE_URL}/u/${scan.metrics.username}`
                }
                text={shareText}
                onShareImage={shareImage}
              />
            </div>
          </div>

          {/* Full scoring report (dimensions table, risk flags, suggestion) —
              outside the card, above the leaderboard */}
          {reportBody && (
            <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-7">
              <div
                className={`report text-[0.95rem] text-zinc-200 ${
                  roasting && !roastLine ? "caret" : ""
                }`}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportBody}</ReactMarkdown>
              </div>
            </div>
          )}

          {/* Badge snippet — appears once the roast finishes (score is recorded). */}
          {!roasting && (
            <div ref={badgeRef} className="mt-6 scroll-mt-6">
              <CopyBadge
                baseUrl={SITE_URL}
                username={scan.metrics.username}
                version={display.score}
              />
            </div>
          )}

          {scan.metrics.days_since_last_activity === null && (
            <p className="mt-3 text-center text-xs text-zinc-600">{t("privateNote")}</p>
          )}

          {/* Off-screen export target for the flex image */}
          <div className="pointer-events-none fixed -left-[9999px] top-0">
            <ShareCard
              ref={cardRef}
              username={scan.metrics.username}
              name={scan.metrics.name}
              avatarUrl={scan.metrics.avatar_url}
              score={display.score}
              tier={display.tier}
              tierLabel={display.tierLabel}
              beat={percentile?.beat ?? null}
              tags={tags ?? { zh: [], en: [] }}
              siteUrl={SITE_URL}
            />
          </div>
        </div>
      )}

      <ByoKeyModal
        open={byoOpen}
        reason={byoReason}
        onClose={() => setByoOpen(false)}
        onSave={(cfg) => {
          setByoOpen(false);
          if (cfg && scan) void runRoast(scan);
        }}
      />
    </div>
  );
}
