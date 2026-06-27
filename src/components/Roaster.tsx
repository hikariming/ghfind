"use client";

import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { tierStyle } from "@/lib/tier";
import type { RoastMeta, ScanResult, Tags, Tier } from "@/lib/types";
import {
  ByoKeyConfig,
  ByoKeyModal,
  loadByoKey,
} from "./ByoKeyModal";
import { CopyBadge } from "./CopyBadge";
import { SponsorPill } from "./Sponsor";
import { ShareCard } from "./ShareCard";
import { Turnstile, turnstileEnabled } from "./Turnstile";

const SITE_URL = "https://githubroast.icu";

interface Display {
  score: number;
  tier: Tier;
  tierLabel: string;
  delta: number;
}

// The LLM report ends with a "🔥 **毒舌点评**: <one-liner>" line. Split it so the
// card shows only that savage one-liner while the scoring table/dimensions render
// separately below (above the leaderboard). While streaming, the marker may not
// have arrived yet — then the whole thing is still "body" and roast stays empty.
function splitReport(md: string): { body: string; roast: string } {
  // Drop the leading "## <username> — <score>/100 · <tier>" heading — the card
  // above already shows score + tier, so it would just be redundant here.
  const stripTitle = (s: string) => s.replace(/^\s*#{1,6}\s+.*(?:\r?\n|$)/, "").trim();
  const m = md.match(/🔥\s*\*{0,2}\s*毒舌点评\s*\*{0,2}\s*[：:]/);
  if (!m || m.index === undefined) return { body: stripTitle(md), roast: "" };
  return {
    body: stripTitle(md.slice(0, m.index)),
    roast: md.slice(m.index + m[0].length).trim(),
  };
}

const SCAN_ERRORS: Record<string, string> = {
  invalid_username: "这不像个 GitHub 用户名，检查一下？",
  account_not_found: "查无此号 —— 拼写没错吧？",
  turnstile_failed: "人机校验没过，刷新页面重试。",
  rate_limited: "手速太快了，喘口气，一分钟后再来。",
  github_rate_limited: "GitHub 接口暂时被打满了，缓一会儿再试。",
  scan_failed: "扫描翻车了，稍后再试。",
};

export function Roaster() {
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const [roasting, setRoasting] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [byoOpen, setByoOpen] = useState(false);
  const [byoReason, setByoReason] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [percentile, setPercentile] = useState<{ beat: number | null; total: number } | null>(
    null,
  );
  const [display, setDisplay] = useState<Display | null>(null);
  const [tags, setTags] = useState<Tags | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const runRoast = useCallback(async (scanResult: ScanResult) => {
    setRoasting(true);
    setReport("");
    const byoKey: ByoKeyConfig | null = loadByoKey();
    try {
      const res = await fetch("/api/roast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scan: scanResult, byoKey }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        if (data?.useByoKey) {
          setByoReason(
            data.error === "llm_quota"
              ? "免费额度用完了 😵 填入你自己的 API Key 继续毒舌（OpenAI / StepFun / Groq 都行）。"
              : data.error === "rate_limited"
                ? "你今天点评得有点多啦 🥵 歇会儿，或填入自己的 API Key 不限量继续。"
                : "服务端还没配默认模型，填入你自己的 API Key 即可开评。",
          );
          setByoOpen(true);
          setRoasting(false);
          return;
        }
        setError("毒舌生成失败，稍后再试或换用自己的 Key。");
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
      setError("网络中断，毒舌没说完。");
    } finally {
      setRoasting(false);
    }
  }, []);

  const submit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!username.trim() || scanning || roasting) return;
      if (turnstileEnabled() && !token) {
        setError("请先完成下方的人机校验。");
        return;
      }
      setError("");
      setScan(null);
      setReport("");
      setPercentile(null);
      setDisplay(null);
      setTags(null);
      setScanning(true);
      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username.trim(), turnstileToken: token }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(SCAN_ERRORS[data?.error] ?? "扫描失败，稍后再试。");
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
        setError("网络出错，连 GitHub 都连不上。");
        setScanning(false);
      }
    },
    [username, token, scanning, roasting, runRoast],
  );

  const beatText =
    percentile && percentile.beat !== null ? `，超越了 ${percentile.beat}% 的开发者` : "";
  const shareText =
    scan && display
      ? `我的 GitHub 含金量被审判了：${display.score.toFixed(2)}/100 · ${display.tier}（${display.tierLabel}）${beatText}。来测测你的 👉 githubroast.icu`
      : "";

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  const style = display ? tierStyle(display.tier) : null;
  const { body: reportBody, roast: roastLine } = splitReport(report);
  const cardRef = useRef<HTMLDivElement>(null);
  const [savingImg, setSavingImg] = useState(false);

  const saveImage = async () => {
    if (!cardRef.current || savingImg) return;
    setSavingImg(true);
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(cardRef.current, { pixelRatio: 2, cacheBust: true });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `github-roast-${scan?.metrics.username ?? "score"}.png`;
      a.click();
    } catch (e) {
      console.error("save image failed:", e);
    } finally {
      setSavingImg(false);
    }
  };

  return (
    <div className="w-full max-w-2xl">
      {/* Input */}
      <form onSubmit={submit} className="flex flex-col items-center gap-3">
        <div className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-1.5 focus-within:border-orange-500/60">
          <span className="pl-3 text-zinc-500">@</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="输入 GitHub 用户名或主页链接"
            className="flex-1 bg-transparent px-1 py-2 text-base outline-none placeholder:text-zinc-600"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={scanning || roasting || !username.trim()}
            className="rounded-lg bg-orange-600 px-5 py-2 font-medium text-white transition hover:bg-orange-500 disabled:opacity-40"
          >
            {scanning ? "审判中…" : "开始审判"}
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
          用自己的模型 / API Key
        </button>
      </div>

      {/* Scanning skeleton */}
      {scanning && (
        <div className="mt-10 animate-pulse text-center text-zinc-500">
          正在扒 {username} 的老底…读 commit、查 PR、数 star、抓刷量痕迹
        </div>
      )}

      {/* Score reveal */}
      {scan && display && style && (
        <div ref={reportRef} className="mt-10">
          <div
            className={`animate-pop mx-auto flex max-w-md flex-col items-center rounded-2xl border bg-white/[0.03] p-6 text-center ring-1 ${style.ring}`}
            style={{ boxShadow: `0 0 80px -20px ${style.glow}` }}
          >
            <a
              href={scan.metrics.profile_url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-zinc-400 hover:text-zinc-200"
            >
              @{scan.metrics.username}
            </a>
            <div className={`mt-2 text-6xl font-black tabular-nums ${style.text}`}>
              {display.score.toFixed(2)}
              <span className="text-2xl text-zinc-600">/100</span>
            </div>
            <div className={`mt-1 text-2xl font-bold ${style.text}`}>
              {style.emoji} {display.tier}
            </div>

            {/* Savage one-liner only — full scoring report renders below the card */}
            <div className="mt-4 w-full rounded-xl border border-orange-500/20 bg-orange-500/[0.04] p-4 text-left">
              <div className="mb-2 text-base font-bold text-orange-400">🔥 毒舌点评</div>
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
                    {roasting ? "AI 正在憋一段毒舌点评，马上端上来…" : "准备生成点评"}
                  </div>
                </div>
              )}

              {tags && (tags.zh.length > 0 || tags.en.length > 0) && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/10 pt-3">
                  {[...tags.zh, ...tags.en].map((t, i) => (
                    <span
                      key={`${t}-${i}`}
                      className="rounded-full border border-orange-400/30 bg-orange-500/10 px-2.5 py-0.5 text-xs font-medium text-orange-200"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {percentile &&
              (percentile.beat === null ? (
                <div className="mt-3 text-sm text-zinc-300">🥇 你是第一个被审判的，前无古人</div>
              ) : (
                <div className="mt-3 text-sm">
                  <span className={`font-semibold ${style.text}`}>🏆 超越了 {percentile.beat}%</span>
                  <span className="text-zinc-400"> 的开发者（共 {percentile.total} 人受审）</span>
                </div>
              ))}

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={copyShare}
                className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-zinc-300 hover:bg-white/10"
              >
                {copied ? "已复制 ✓" : "复制分享文案"}
              </button>
              <button
                onClick={saveImage}
                disabled={savingImg}
                className="rounded-full bg-orange-600/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-50"
              >
                {savingImg ? "生成中…" : "📸 保存炫耀图"}
              </button>
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
            <div className="mt-6">
              <CopyBadge baseUrl={SITE_URL} username={scan.metrics.username} />
            </div>
          )}

          {scan.metrics.days_since_last_activity === null && (
            <p className="mt-3 text-center text-xs text-zinc-600">
              注：评分仅基于公开信号，私有贡献不计入，可能低估私有组织的活跃员工。
            </p>
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
