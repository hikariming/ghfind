"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import QRCode from "qrcode";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ShareMenu } from "@/components/ShareMenu";
import { createShareCardBlob } from "@/components/shareCardExport";
import { SITE_URL, localePath } from "@/lib/site";
import { trackEvent } from "@/lib/track";
import type { CandidateReport } from "@/lib/talent-match/types";
import { fieldClass, primaryButton, secondaryButton, type Copy } from "./parts";

/** Only share the explicit public card fields; never link to a private report. */
export function TalentMatchResultModal({ report, copy, open, onClose }: {
  report: CandidateReport; copy: Copy; open: boolean; onClose: () => void;
}) {
  const { c, tx } = copy;
  const locale = useLocale();
  // Old reports may include other employers. Never label those as DeepSeek.
  const matches = report.matches.filter((m) => m.company.toLowerCase() === "deepseek");
  const [selectedId, setSelectedId] = useState(matches[0]?.jobId ?? "");
  const selected = matches.find((m) => m.jobId === selectedId) ?? matches[0];
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [qr, setQr] = useState("");
  const link = `${SITE_URL}${localePath(locale, "/talent-match")}?utm_source=talent_card&utm_medium=share&utm_campaign=deepseek`;
  const text = selected ? c(`我测出来最匹配的 DeepSeek 岗位是「${tx(selected.title)}」，你呢？`, `My closest DeepSeek role is ${tx(selected.title)}. What's yours?`) : "";

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(link, { width: 160, margin: 1, errorCorrectionLevel: "M" })
      .then((url) => { if (live) setQr(url); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [link]);

  const exportImage = async (share: boolean) => {
    if (busy || !cardRef.current) return;
    setBusy(true);
    setError(false);
    try {
      const blob = await createShareCardBlob(cardRef.current, getComputedStyle(cardRef.current).backgroundColor);
      if (!blob) throw new Error("Empty export");
      const file = new File([blob], `ghfind-deepseek-${report.profile.login}.png`, { type: "image/png" });
      if (share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text, url: link });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      trackEvent("talent_card_export", { channel: share ? "image" : "download" });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(true);
    } finally { setBusy(false); }
  };

  if (!selected) return null;
  const skills = selected.matched.slice(0, 3);
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogClose aria-label={c("关闭", "Close")} className="absolute end-2 top-2 rounded-full p-2 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"><X className="h-4 w-4" /></DialogClose>
        <DialogTitle className="pe-6">{c("我的 DeepSeek 岗位匹配结果", "My DeepSeek role match")}</DialogTitle>
        <DialogDescription>{c("选一个岗位，晒出你的匹配结果。", "Choose a role and share your result.")}</DialogDescription>
        <div ref={cardRef} data-share-card-ready={qr ? "true" : "false"} className="rounded-2xl border border-white/10 bg-card p-5 text-foreground">
          <p className="text-sm text-zinc-400">{c("如果去 DeepSeek，我最匹配什么岗位？", "Which DeepSeek role fits me best?")}</p>
          <p className="mt-5 break-all text-sm font-semibold text-zinc-300">@{report.profile.login}</p>
          <p className="mt-3 text-xs font-semibold text-zinc-500">{selected.fit < 55 ? c("最接近的岗位方向", "Closest role direction") : c(selected.jobId === matches[0]?.jobId ? "我的最佳匹配" : "我的岗位匹配", selected.jobId === matches[0]?.jobId ? "My top role match" : "My role match")}</p>
          <h3 className="mt-2 break-words text-3xl font-black leading-tight text-zinc-100">{tx(selected.title)}</h3>
          <div className="mt-5 rounded-xl border border-white/10 bg-white/5 p-3">
            <span className="text-xs text-zinc-400">{c("岗位要求匹配度", "Role requirement fit")}</span>
            <p className="mt-1 text-2xl font-black text-zinc-100">{selected.fit}<span className="text-sm font-normal text-zinc-500"> / 100</span></p>
          </div>
          {skills.length > 0 && <div className="mt-4"><p className="text-xs text-zinc-500">{c("匹配技能 · 含简历自述与 GitHub 证据", "Matching skills · résumé claims & GitHub evidence")}</p><p className="mt-1 break-words text-sm font-semibold text-zinc-200">{skills.join(" · ")}</p></div>}
          <div className="mt-6 flex items-center justify-between gap-3 border-t border-white/10 pt-4">
            <div className="min-w-0"><p className="text-sm font-bold text-zinc-100">{c("你会匹配到什么岗位？", "What's your DeepSeek role?")}</p><p className="mt-1 text-xs text-zinc-400">{c("扫码生成你的名片", "Scan to create your card")}</p><p className="mt-2 text-xs text-zinc-500">ghfind.com/talent-match</p></div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr && <img src={qr} width={72} height={72} alt={c("生成你的名片二维码", "Create your card QR code")} className="shrink-0 rounded-lg" />}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">{c("ghfind 独立分析 · 基于收录的 DeepSeek 岗位 · 非官方招聘评估", "Independent ghfind analysis · indexed DeepSeek roles · not an official hiring assessment")}</p>
        </div>
        <div><label htmlFor="talent-card-role" className="mb-1 block text-xs text-zinc-400">{c("选择分享岗位", "Choose a role to share")}</label><select id="talent-card-role" value={selected.jobId} className={`${fieldClass} w-full`} onChange={(e) => { setSelectedId(e.target.value); trackEvent("talent_card_role_select"); }}>{matches.map((m) => <option key={m.jobId} value={m.jobId}>{tx(m.title)} · {m.fit}/100</option>)}</select></div>
        <div className="flex flex-wrap items-center justify-center gap-2"><button type="button" className={primaryButton} disabled={busy || !qr} onClick={() => void exportImage(false)}>{busy ? c("生成图片中…", "Preparing image…") : c("保存图片", "Save image")}</button><ShareMenu link={link} text={text} onShareImage={() => void exportImage(true)} /></div>
        {error && <p role="alert" className="text-center text-xs text-rose-400">{c("图片生成失败，请重试或复制分享链接。", "Image export failed. Retry or copy the share link.")}</p>}
        <button type="button" className={secondaryButton} onClick={onClose}>{c("查看完整报告", "View full report")}</button>
      </DialogContent>
    </Dialog>
  );
}
