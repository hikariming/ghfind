"use client";

import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { CopyBadge } from "./CopyBadge";
import { ShareMenu } from "./ShareMenu";
import { SponsorPill } from "./Sponsor";
import { ShareCard } from "./ShareCard";
import { ShareCardExportHost } from "./ShareCardExportHost";
import { createShareCardBlob } from "./shareCardExport";
import { TierAvatarFrame } from "./TierAvatarFrame";
import { Turnstile, turnstileEnabled } from "./Turnstile";
import { Omnibox } from "./Omnibox";

const SITE_URL = "https://ghfind.com";

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
  const searchParams = useSearchParams();

  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const [roasting, setRoasting] = useState(false);
  // Live progress label streamed from the server during the (slow, reasoning-model)
  // judge → roast wait, so the card shows "正在校准评分… (8s)" instead of a frozen spinner.
  const [thinking, setThinking] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [byoOpen, setByoOpen] = useState(false);
  const [byoReason, setByoReason] = useState<string | undefined>();
  const [percentile, setPercentile] = useState<{
    beat: number | null;
    total: number;
    rank: number | null;
  } | null>(null);
  const [display, setDisplay] = useState<Display | null>(null);
  const [tags, setTags] = useState<Tags | null>(null);
  // Bilingual one-liner from the X-Roast-Meta header (arrives before the body
  // streams). The card shows the side matching the current locale.
  const [metaRoast, setMetaRoast] = useState<RoastLine | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const lastPrefillRef = useRef<string | null>(null);

  // Deep-link prefill (?username=): seed the Omnibox; it renders the value and
  // the user hits Enter to roast. (Focus/scroll now live inside the Omnibox.)
  useEffect(() => {
    const seededUsername = searchParams.get("username")?.trim();
    if (!seededUsername || seededUsername === lastPrefillRef.current) return;
    lastPrefillRef.current = seededUsername;
    setUsername(seededUsername);
  }, [searchParams]);

  const runRoast = useCallback(
    async (scanResult: ScanResult) => {
      setRoasting(true);
      setReport("");
      setMetaRoast(null);
      setThinking("");

      // Decode a base64 RoastMeta (header fast path or in-band M-frame) into the
      // score card / tags / one-liner.
      const applyMeta = (b64: string) => {
        try {
          const json = new TextDecoder().decode(
            Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
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
      };
      // Map a server error (preflight JSON or in-band E-frame) to the BYO modal /
      // inline error, then stop. Returns true if it was an error.
      const handleError = (data: { error?: string; useByoKey?: boolean }): boolean => {
        if (data?.useByoKey) {
          setByoReason(
            data.error === "llm_quota"
              ? t("byoReasonQuota")
              : data.error === "rate_limited"
                ? t("byoReasonRate")
                : t("byoReasonDefault"),
          );
          setByoOpen(true);
          return true;
        }
        if (data?.error) {
          setError(t("errRoastFailed"));
          return true;
        }
        return false;
      };

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
          if (!handleError(data)) setError(t("errRoastFailed"));
          setRoasting(false);
          return;
        }

        // The header carries a deterministic meta fallback (sent before the body
        // can know the AI-adjusted values); the real meta arrives as an M-frame.
        const metaHeader = res.headers.get("X-Roast-Meta");
        if (metaHeader) applyMeta(metaHeader);

        // The streamed body is plain report markdown EXCEPT for leading control
        // frames (see the server's FRAME protocol): \x1f-prefixed lines carrying
        // progress (T), the adjusted meta (M, ends the control phase), or an
        // error (E). The cached fast path sends pure markdown with no frames.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let inReport = false;
        let acc = "";
        let aborted = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          while (!inReport && buf.length > 0) {
            // Anything not starting with the frame separator is report content.
            if (buf[0] !== "\x1f") {
              inReport = true;
              break;
            }
            const nl = buf.indexOf("\n");
            if (nl === -1) break; // partial control line — wait for more bytes
            const type = buf[1];
            const payload = buf.slice(2, nl);
            buf = buf.slice(nl + 1);
            if (type === "T") {
              setThinking(payload);
            } else if (type === "M") {
              applyMeta(payload);
              inReport = true;
            } else if (type === "E") {
              try {
                handleError(JSON.parse(payload));
              } catch {
                setError(t("errRoastFailed"));
              }
              aborted = true;
              break;
            }
          }
          if (aborted) break;
          if (inReport && buf) {
            acc += buf;
            buf = "";
            setReport(acc);
          }
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
    // `overrideUser` lets the Omnibox roast a picked autocomplete handle without
    // waiting for the controlled `username` state to flush.
    async (overrideUser?: string) => {
      if (scanning || roasting) return;
      const uname = (overrideUser ?? username).trim();
      if (!uname) {
        setError(t("errEmpty"));
        return;
      }
      if (overrideUser && overrideUser !== username) setUsername(overrideUser);
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
      setThinking("");
      setScanning(true);
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: uname, turnstileToken: token }),
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
    return createShareCardBlob(cardRef.current);
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
    <div className="w-full max-w-6xl">
      {/* Omnibox: roast / PK / language / org / search in one input. A bare
          handle still roasts in place (via onRoast); other intents navigate. */}
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3">
        <Omnibox
          value={username}
          onChange={setUsername}
          onRoast={(u) => void submit(u)}
          busy={scanning || roasting}
        />
        <Turnstile onToken={setToken} />
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </div>

      <div className="mt-3 flex flex-col items-center gap-3">
        <SponsorPill large />
        <Button
          type="button"
          onClick={() => {
            setByoReason(undefined);
            setByoOpen(true);
          }}
          variant="link"
          size="sm"
          className="h-auto px-0 text-xs text-zinc-500"
        >
          {t("byoLink")}
        </Button>
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
                  <div className="text-sm text-zinc-400 tabular-nums">
                    {roasting ? thinking || t("roastThinking") : t("roastPending")}
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
                <div className="mt-3 space-y-1 text-sm">
                  {percentile.rank != null && (
                    <div>
                      {t.rich("rankLine", {
                        rank: percentile.rank,
                        total: percentile.total,
                        hl: (c) => <span className={`font-semibold ${style.text}`}>{c}</span>,
                        muted: (c) => <span className="text-zinc-400">{c}</span>,
                      })}
                    </div>
                  )}
                  <div>
                    {t.rich("beatLine", {
                      beat: percentile.beat.toFixed(1),
                      total: percentile.total,
                      hl: (c) => <span className={`font-semibold ${style.text}`}>{c}</span>,
                      muted: (c) => <span className="text-zinc-400">{c}</span>,
                    })}
                  </div>
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

          <ShareCardExportHost>
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
            />
          </ShareCardExportHost>
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
