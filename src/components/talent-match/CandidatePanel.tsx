"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Code2, FlaskConical, GitPullRequest, GraduationCap, Hammer, RefreshCw, Sparkles, Star, Trash2 } from "lucide-react";
import { Turnstile, turnstileEnabled } from "@/components/Turnstile";
import { Link } from "@/i18n/navigation";
import { DIMENSIONS } from "@/lib/dimensions";
import type { EmploymentType } from "@/lib/jobs";
import { SUBSCORE_MAX } from "@/lib/score-presentation";
import { createReport, deleteTalentProfile, getReport, getReports, listResumeSources, type ReportSummary, type ResumeSourceOption } from "@/lib/talent-match/client";
import { MOCK_CANDIDATE_REPORT } from "@/lib/talent-match/mock";
import { CANDIDATE_STAGES, type CandidateReport, type Cost, type GrowthKind, type JobMatch, type ProfileItem } from "@/lib/talent-match/types";
import type { SubScoreKey } from "@/lib/types";
import { Bar, Breakdown, Card, Chip, FitScore, SourceBadge, StageProgress, fieldClass, primaryButton, secondaryButton, type Copy } from "./parts";
import { TalentMatchResultModal } from "./TalentMatchResultModal";
import { trackEvent } from "@/lib/track";
import { ReportHistory } from "./ReportHistory";
import type { PdfResume } from "./ResumeDropzone";
import { ResumeSourcePicker, sourceKeyOf, type SourceMode } from "./ResumeSourcePicker";
import { OpenToOpportunities } from "./OpenToOpportunities";

const DIMENSION_LABELS: Record<SubScoreKey, [string, string]> = {
  account_maturity: ["账号成熟度", "Account maturity"],
  original_project_quality: ["原创与主导项目质量", "Original & Led Projects"],
  contribution_quality: ["贡献质量", "Contribution quality"],
  ecosystem_impact: ["生态影响力", "Ecosystem impact"],
  community_influence: ["社区影响力", "Community influence"],
  activity_authenticity: ["活跃真实性", "Activity authenticity"],
};

const STAGE_LABELS: Record<(typeof CANDIDATE_STAGES)[number], [string, string]> = {
  normalize: ["读取简历与 GitHub 资料", "Reading your résumé and GitHub data"],
  extract: ["抽取结构化人才画像", "Extracting a structured talent profile"],
  verify: ["用 GitHub 数据验证能力", "Verifying skills against GitHub evidence"],
  match: ["匹配岗位并计算差距", "Matching roles and measuring gaps"],
  advise: ["生成成长建议", "Writing your growth plan"],
};

const GROWTH_ICONS: Record<GrowthKind, typeof Code2> = {
  open_source: GitPullRequest,
  skill: BookOpen,
  research: FlaskConical,
  education: GraduationCap,
  portfolio: Hammer,
};

/** Stages advance on elapsed time while the Workflow runs; the server reports only queued/running/done. */
const STAGE_ESTIMATE_MS = 9_000;
const POLL_MS = 3_000;

const ERROR_COPY: Record<string, [string, string]> = {
  quota_exhausted: ["本月的免费报告已用完，下月 1 日重置。", "You've used this month's free reports. They reset on the 1st."],
  in_flight: ["已有一份报告正在生成，请等它完成。", "A report is already being generated. Wait for it to finish."],
  rate_limited: ["提交太频繁，请一分钟后再试。", "Too many submissions. Try again in a minute."],
  budget_exhausted: ["本月的免费额度已全部用完，请稍后再来。", "This month's free capacity is used up. Please check back later."],
  resume_missing: ["没有找到这份简历的内容，请先在「我的简历」中保存到云端。", "That résumé has no content. Save it to the cloud in My résumé first."],
  turnstile_failed: ["人机验证未通过，请重试。", "The human check failed. Please try again."],
  model_output_invalid: ["AI 没能读懂这份简历，额度未扣除。可以补充内容后重试。", "The AI couldn't read this résumé; no quota was used. Add detail and try again."],
  stale: ["生成中断了，额度未扣除，请重试。", "Generation stopped; no quota was used. Please try again."],
  sign_in_required: ["请先登录。", "Please sign in first."],
  pdf_unreadable: ["这个 PDF 里读不到文字（可能是扫描件或图片），请换一份可复制文字的 PDF。", "No text could be read from this PDF (it may be a scan or an image). Use a PDF with selectable text."],
};
const GENERIC_ERROR: [string, string] = ["生成失败，额度未扣除，请稍后重试。", "Something went wrong; no quota was used. Please try again later."];

const EMPLOYMENT_OPTIONS: [EmploymentType, [string, string]][] = [
  ["full_time", ["全职", "Full-time"]],
  ["intern", ["实习", "Internship"]],
  ["part_time", ["兼职", "Part-time"]],
];

type Phase =
  | { kind: "loading" }
  | { kind: "form"; error?: string }
  | { kind: "running"; id: string; startedAt: number }
  | { kind: "report"; report: CandidateReport; sample?: boolean };

export function CandidatePanel({
  copy,
  login,
  handoff,
  canGenerate,
  onQuotaChange,
  onSignIn,
}: {
  copy: Copy;
  /** Signed-in GitHub login, or null when signed out. */
  login: string | null;
  /** GitHub handle passed in from the home search box, if any. */
  handoff: string | null;
  /** False when out of quota. */
  canGenerate: boolean;
  /** Re-read the quota after a report starts, finishes or is deleted. */
  onQuotaChange: () => void;
  onSignIn: () => void;
}) {
  const { c } = copy;
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [mode, setMode] = useState<SourceMode>("existing");
  const [sources, setSources] = useState<ResumeSourceOption[] | null | "error">(null);
  const [sourceKey, setSourceKey] = useState("");
  const [location, setLocation] = useState("");
  const [remote, setRemote] = useState(false);
  const [employment, setEmployment] = useState<EmploymentType[]>(["full_time"]);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** Text read from an uploaded PDF in this browser; the file never leaves it. */
  const [pdf, setPdf] = useState<PdfResume | null>(null);
  const [history, setHistory] = useState<ReportSummary[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const revealed = useRef(new Set<string>());
  const revealReport = useCallback((report: CandidateReport) => {
    setPhase({ kind: "report", report });
    if (!report.matches.some((m) => m.company.toLowerCase() === "deepseek")) return;
    const key = `talent-card-seen:${report.id}`;
    let seen = revealed.current.has(report.id);
    try { seen ||= sessionStorage.getItem(key) === "1"; sessionStorage.setItem(key, "1"); } catch { /* memory guard still works */ }
    revealed.current.add(report.id);
    if (!seen) {
      setShareOpen(true);
      trackEvent("talent_card_view", { source: "completion" });
    }
  }, []);

  const refreshHistory = useCallback(() => {
    getReports().then((result) => { if (result.ok) setHistory(result.value.history); });
  }, []);

  // Signed in: resume a report in flight, or show the latest finished one.
  useEffect(() => {
    if (!login) {
      Promise.resolve().then(() => setPhase({ kind: "form" }));
      return;
    }
    let live = true;
    getReports().then((result) => {
      if (!live) return;
      const latest = result.ok ? result.value.latest : null;
      setHistory(result.ok ? result.value.history : []);
      if (latest && (latest.status === "queued" || latest.status === "running")) setPhase({ kind: "running", id: latest.id, startedAt: Date.now() });
      else if (latest?.status === "done" && latest.report) setPhase({ kind: "report", report: latest.report });
      else setPhase({ kind: "form" });
    });
    listResumeSources().then((result) => {
      if (!live) return;
      if (!result.ok) {
        setSources("error");
        return;
      }
      setSources(result.value);
      if (result.value[0]) setSourceKey(sourceKeyOf(result.value[0]));
    });
    return () => { live = false; };
  }, [login]);

  // Poll a running report until it finishes.
  useEffect(() => {
    if (phase.kind !== "running") return;
    let live = true;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const poll = setInterval(async () => {
      const result = await getReport(phase.id);
      if (!live || !result.ok) return;
      if (result.value.status === "done" && result.value.report) {
        revealReport(result.value.report);
        trackEvent("talent_report_complete");
        onQuotaChange();
        refreshHistory();
      } else if (result.value.status === "failed") {
        setPhase({ kind: "form", error: result.value.error ?? "generation_failed" });
        onQuotaChange();
        refreshHistory();
      }
    }, POLL_MS);
    return () => { live = false; clearInterval(tick); clearInterval(poll); };
  }, [phase, onQuotaChange, refreshHistory, revealReport]);

  const usingPdf = mode === "upload";
  const source = Array.isArray(sources) ? sources.find((s) => sourceKeyOf(s) === sourceKey) ?? null : null;
  const hasInput = usingPdf ? pdf !== null : source !== null;

  const openReport = async (summary: ReportSummary) => {
    setShareOpen(false);
    setOpeningId(summary.id);
    setHistoryError(false);
    const result = await getReport(summary.id);
    setOpeningId(null);
    if (result.ok && result.value.status === "done" && result.value.report) {
      setPhase({ kind: "report", report: result.value.report });
    } else if (result.ok && (result.value.status === "queued" || result.value.status === "running")) {
      setPhase({ kind: "running", id: summary.id, startedAt: Date.parse(summary.createdAt) || Date.now() });
    } else {
      setHistoryError(true);
      refreshHistory();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submit = async () => {
    if (!hasInput) return;
    setShareOpen(false);
    setSubmitting(true);
    const result = await createReport({
      source: usingPdf && pdf ? { kind: "pdf", text: pdf.text } : source?.kind === "resume" ? { kind: "resume", id: source.id } : { kind: "profile" },
      preferences: { location: location.trim(), remote, employment },
      turnstileToken: token || null,
    });
    setSubmitting(false);
    setToken("");
    if (!result.ok) {
      setPhase({ kind: "form", error: result.error });
      return;
    }
    if (result.value.status === "done") {
      // Identical input: the finished report is reused and no quota is spent.
      const done = await getReport(result.value.id);
      if (done.ok && done.value.report) revealReport(done.value.report);
      return;
    }
    setPhase({ kind: "running", id: result.value.id, startedAt: Date.now() });
    onQuotaChange();
    refreshHistory();
  };

  const deleteProfile = async () => {
    if (!window.confirm(c("删除你的人才画像和全部报告？此操作无法撤销。", "Delete your talent profile and every report? This can't be undone."))) return;
    const result = await deleteTalentProfile();
    if (result.ok) {
      setPhase({ kind: "form" });
      setHistory([]);
      onQuotaChange();
    } else {
      window.alert(c("删除失败，请稍后重试。", "Couldn't delete. Please try again later."));
    }
  };

  if (phase.kind === "loading") {
    return <Card><p className="text-sm text-zinc-500">{c("加载中…", "Loading…")}</p></Card>;
  }

  // A PDF is extracted inside the submit request; show that as the extract stage.
  if (submitting && usingPdf) {
    return (
      <Card title={c("正在生成报告", "Generating your report")}>
        <StageProgress stages={CANDIDATE_STAGES.map((s) => c(...STAGE_LABELS[s]))} current={1} />
        <p className="mt-5 text-xs text-zinc-500">{c("正在读取你的 PDF，通常需要 15–40 秒，请保持页面打开。", "Reading your PDF, usually 15–40 seconds. Keep this page open.")}</p>
      </Card>
    );
  }

  const historyCard = login && (
    <ReportHistory
      history={history}
      currentId={phase.kind === "report" && !phase.sample ? phase.report.id : phase.kind === "running" ? phase.id : null}
      openingId={openingId}
      error={historyError}
      onOpen={openReport}
    />
  );

  if (phase.kind === "running") {
    const stage = Math.min(CANDIDATE_STAGES.length - 1, Math.floor((now - phase.startedAt) / STAGE_ESTIMATE_MS));
    return (
      <div className="space-y-5">
        <Card title={c("正在生成报告", "Generating your report")}>
          <StageProgress stages={CANDIDATE_STAGES.map((s) => c(...STAGE_LABELS[s]))} current={stage} />
          <p className="mt-5 text-xs text-zinc-500">{c("通常需要 30–60 秒，可以离开页面，回来后会在这里显示。", "Usually 30–60 seconds. You can leave; it will be here when you come back.")}</p>
        </Card>
        {historyCard}
      </div>
    );
  }

  if (phase.kind === "report") {
    return (
      <div className="space-y-5">
        {!phase.sample && <TalentMatchResultModal key={phase.report.id} report={phase.report} copy={copy} open={shareOpen} onClose={() => setShareOpen(false)} />}
        <CandidateReportView
          report={phase.report}
          copy={copy}
          sample={phase.sample === true}
          onReset={() => { setShareOpen(false); setPhase({ kind: "form" }); }}
          onDelete={phase.sample ? undefined : deleteProfile}
          onShare={!phase.sample && phase.report.matches.some((m) => m.company.toLowerCase() === "deepseek") ? () => { setShareOpen(true); trackEvent("talent_card_view", { source: "report" }); } : undefined}
        />
        {!phase.sample && historyCard}
      </div>
    );
  }

  const errorCopy = phase.error ? ERROR_COPY[phase.error] ?? GENERIC_ERROR : null;
  const needToken = turnstileEnabled() && !token;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
      <Card title={c("你的资料", "Your material")} className="min-w-0">
        {!login ? (
          <p className="text-sm text-zinc-400">{c("登录 GitHub 后，用你的简历（云端简历或 PDF）和 GitHub 数据生成报告。", "Sign in with GitHub to generate a report from your résumé (cloud-saved or a PDF) and your GitHub evidence.")}</p>
        ) : (
          <div className="space-y-4">
            <ResumeSourcePicker
              mode={mode}
              onMode={setMode}
              sources={sources}
              sourceKey={sourceKey}
              onSourceKey={setSourceKey}
              pdf={pdf}
              onPdf={setPdf}
            />

            <div>
              <p className="mb-1.5 text-sm font-medium text-zinc-200">GitHub</p>
              <p className="text-sm text-zinc-300">@{login}</p>
              <p className="mt-1 text-xs text-zinc-500">
                {c("技能会用这个账号已扫描的公开数据验证。", "Skills are verified against this account's scanned public data.")}
                {handoff && handoff.toLowerCase() !== login.toLowerCase()
                  ? c(` 报告只针对你自己的账号，不是 @${handoff}。`, ` Reports cover your own account, not @${handoff}.`)
                  : ""}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="tm-location" className="mb-1.5 block text-sm font-medium text-zinc-200">{c("期望地点", "Preferred location")}</label>
                <input id="tm-location" className={fieldClass} maxLength={200} placeholder={c("例如：北京 / 上海", "e.g. Beijing / Shanghai")} value={location} onChange={(e) => setLocation(e.target.value)} />
              </div>
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-zinc-200">{c("工作类型", "Employment")}</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-zinc-300">
                  {EMPLOYMENT_OPTIONS.map(([type, label]) => (
                    <label key={type} className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={employment.includes(type)}
                        onChange={(e) => setEmployment(e.target.checked ? [...employment, type] : employment.filter((t) => t !== type))}
                      />
                      {c(...label)}
                    </label>
                  ))}
                  <label className="inline-flex items-center gap-1.5">
                    <input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} />
                    {c("可远程", "Remote OK")}
                  </label>
                </div>
              </fieldset>
            </div>
            <p className="text-xs text-zinc-500">{c("个人网站即将支持。", "Personal websites are coming soon.")}</p>
          </div>
        )}
      </Card>

      <Card title={c("会得到什么", "What you get")} className="min-w-0">
        <ul className="space-y-2.5 text-sm text-zinc-300">
          <li>{c("· 多维人才画像，区分「已验证」与「自述」", "· A multi-dimension profile, verified vs claimed")}</li>
          <li>{c("· 匹配岗位与匹配度拆解", "· Matching roles with a score breakdown")}</li>
          <li>{c("· 缺口分析与补齐成本", "· Gaps and the cost to close them")}</li>
          <li>{c("· 成长路线：开源贡献、技能、科研、学历", "· A growth plan: open source, skills, research, education")}</li>
        </ul>
        <div className="mt-5">
          {errorCopy && <p role="alert" className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-rose-400">{c(...errorCopy)}</p>}
          {login ? (
            <>
              {turnstileEnabled() && hasInput && canGenerate && !token && <Turnstile onToken={setToken} />}
              <button type="button" className={`${primaryButton} w-full`} disabled={!canGenerate || !hasInput || submitting || needToken} onClick={submit}>
                <Sparkles className="h-4 w-4" aria-hidden="true" />{submitting ? c("提交中…", "Submitting…") : c("生成报告", "Generate report")}
              </button>
              {!canGenerate && <p className="mt-2 text-xs text-zinc-500">{c("本月额度已用完。", "No reports left this month.")}</p>}
            </>
          ) : (
            <button type="button" className={`${primaryButton} w-full`} onClick={onSignIn}>{c("登录 GitHub 后生成", "Sign in with GitHub to generate")}</button>
          )}
          <button type="button" className={`${secondaryButton} mt-2 w-full`} onClick={() => setPhase({ kind: "report", report: MOCK_CANDIDATE_REPORT, sample: true })}>{c("查看示例报告", "View a sample report")}</button>
        </div>
      </Card>
      {historyCard && <div className="min-w-0 lg:col-span-2">{historyCard}</div>}
    </div>
  );
}

function formatStars(stars: number): string {
  return stars >= 1000 ? `${(stars / 1000).toFixed(stars >= 10_000 ? 0 : 1)}k` : String(stars);
}

const costLabel = (cost: Cost, c: Copy["c"]) => ({ low: c("低成本", "Low effort"), medium: c("中等成本", "Medium effort"), high: c("高成本", "High effort") })[cost];
const reachLabel = (reach: JobMatch["reach"], c: Copy["c"]) => ({ high: c("可达性高", "Highly reachable"), medium: c("可达性中", "Reachable"), low: c("可达性低", "Stretch") })[reach];

function CandidateReportView({ report, copy, sample, onReset, onDelete, onShare }: { report: CandidateReport; copy: Copy; sample: boolean; onReset: () => void; onDelete?: () => void; onShare?: () => void }) {
  const { c, tx } = copy;
  const { profile } = report;
  const matches = [...report.matches].sort((a, b) => b.fit - a.fit);
  const background: [string, ProfileItem[]][] = [
    [c("经历", "Experience"), profile.experience],
    [c("教育", "Education"), profile.education],
    [c("科研", "Research"), profile.research],
  ];

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-zinc-500">@{profile.login} · {tx(profile.direction)} · {c(`${profile.years} 年经验`, `${profile.years} yrs experience`)}</p>
            <h2 className="mt-1 text-xl font-black text-zinc-100">{profile.name}</h2>
            <p className="mt-1 text-sm text-zinc-300">{tx(profile.headline)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {onShare && <button type="button" className={primaryButton} onClick={onShare}>{c("分享岗位名片", "Share role card")}</button>}
            <button type="button" className={secondaryButton} onClick={onReset}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{sample ? c("返回", "Back") : c("修改资料", "Edit inputs")}</button>
            {onDelete && <button type="button" className={secondaryButton} onClick={onDelete}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{c("删除画像", "Delete profile")}</button>}
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-zinc-300">{tx(report.summary)}</p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {report.strengths.map((s) => <li key={s.en}><Chip tone="good">{tx(s)}</Chip></li>)}
        </ul>
        {sample && <p className="mt-4 text-xs text-amber-300">{c("这是示例报告，数据均为虚构。", "This is a sample report; all data is invented.")}</p>}
      </Card>

      {!sample && <OpenToOpportunities />}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={c("GitHub 证据强度", "GitHub evidence")} aside={<SourceBadge source="verified" copy={copy} />}>
          <ul className="space-y-3">
            {DIMENSIONS.map((key) => (
              <li key={key}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-zinc-400">{c(...DIMENSION_LABELS[key])}</span>
                  <span className="tabular-nums text-zinc-300">{profile.dimensions[key]} / {SUBSCORE_MAX[key]}</span>
                </div>
                <Bar pct={profile.dimensions[key] / SUBSCORE_MAX[key]} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title={c("背景", "Background")}>
          <div className="space-y-4">
            {background.map(([label, items]) => (
              <div key={label}>
                <h3 className="mb-2 text-xs font-semibold text-zinc-500">{label}</h3>
                {items.length === 0 ? (
                  <p className="text-sm text-zinc-500">{c("未在资料中发现", "Nothing found in your material")}</p>
                ) : (
                  <ul className="space-y-2">
                    {items.map((item) => (
                      <li key={item.title.en} className="flex items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block text-sm text-zinc-200">{tx(item.title)}</span>
                          <span className="block text-xs text-zinc-500">{tx(item.detail)}</span>
                        </span>
                        <SourceBadge source={item.source} copy={copy} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <p className="border-t border-white/5 pt-3 text-xs text-zinc-500">
              {c("期望：", "Preferences: ")}{tx(profile.preferences.location)} · {tx(profile.preferences.employment)}{profile.preferences.remote ? c(" · 可远程", " · Remote OK") : ""}
            </p>
          </div>
        </Card>
      </div>

      <Card title={c("技能", "Skills")}>
        <ul className="grid gap-3 sm:grid-cols-2">
          {profile.skills.map((skill) => (
            <li key={skill.id} className="rounded-xl border border-white/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-zinc-100">{skill.label}</span>
                <SourceBadge source={skill.source} copy={copy} />
              </div>
              <div className="mt-2 flex gap-1" aria-label={c(`熟练度 ${skill.level} / 4`, `Level ${skill.level} of 4`)}>
                {[1, 2, 3, 4].map((n) => <span key={n} className={`h-1.5 flex-1 rounded-full ${n <= skill.level ? "bg-emerald-400" : "bg-white/10"}`} />)}
              </div>
              <p className="mt-2 text-xs text-zinc-500">{tx(skill.evidence)}</p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={report.matchVersion >= 2 ? c("DeepSeek 匹配岗位", "DeepSeek role matches") : c("推荐岗位", "Matching roles")} aside={<Link href="/jobs" prefetch={false} className="text-xs text-zinc-400 hover:text-zinc-200">{c("全部岗位", "All roles")} →</Link>}>
        {matches.length === 0 && <p className="text-sm text-zinc-400">{c("暂无可分析的 DeepSeek 岗位，稍后再来看看。", "No DeepSeek roles are available for analysis. Check back later.")}</p>}
        <ul className="space-y-4">
          {matches.map((m) => (
            <li key={m.jobId} className="rounded-xl border border-white/10 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-500">{m.company} · {tx(m.location)}</p>
                  <h3 className="mt-0.5 font-semibold text-zinc-100">{tx(m.title)}</h3>
                  <p className="mt-1 text-sm text-zinc-400">{tx(m.reason)}</p>
                </div>
                <FitScore fit={m.fit} label={reachLabel(m.reach, c)} />
              </div>
              <div className="mt-4"><Breakdown breakdown={m.breakdown} copy={copy} /></div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {m.matched.map((s) => <Chip key={s} tone="good">{s}</Chip>)}
                {m.gaps.map((g) => <Chip key={g.label.en} tone="gap">{tx(g.label)} · {costLabel(g.cost, c)}</Chip>)}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={report.matchVersion >= 2 ? c("最佳岗位的成长路线", "Growth plan for your top role") : c("成长路线", "Growth plan")}>
        <ol className="space-y-4">
          {report.growth.map((g) => {
            const Icon = GROWTH_ICONS[g.kind];
            return (
              <li key={g.title.en} className="flex gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold text-zinc-100">{tx(g.title)}</h3>
                    <span className="text-xs text-zinc-500">{tx(g.horizon)}</span>
                  </div>
                  <p className="mt-1 text-sm text-zinc-400">{tx(g.detail)}</p>
                  {g.repo && (
                    <Link
                      href={`/developers/repo/${g.repo.fullName.split("/").map(encodeURIComponent).join("/")}`}
                      prefetch={false}
                      className="mt-2 inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5"
                    >
                      <Code2 className="h-3.5 w-3.5" aria-hidden="true" />{g.repo.fullName}
                      <span className="inline-flex items-center gap-0.5 text-zinc-500"><Star className="h-3 w-3" aria-hidden="true" />{formatStars(g.repo.stars)}</span>
                      <span className="text-zinc-500">{g.repo.language}</span>
                      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {g.closes.map((gap) => <Chip key={gap.en}>{c("补齐：", "Closes: ")}{tx(gap)}</Chip>)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <p className="text-xs text-zinc-500">
        {c(`匹配度由确定性规则计算（v${report.matchVersion}），AI 只负责抽取资料与撰写建议。推荐项目来自 ghfind 项目库。`, `Match scores come from deterministic rules (v${report.matchVersion}); AI only extracts your material and writes the advice. Recommended projects come from the ghfind project feed.`)}
      </p>
    </div>
  );
}
