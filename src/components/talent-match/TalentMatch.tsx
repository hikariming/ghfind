"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, UserRound } from "lucide-react";
import { fetchMe } from "@/lib/me-client";
import { signInWithGitHub } from "@/lib/oauth-client";
import { getQuota } from "@/lib/talent-match/client";
import type { Quota } from "@/lib/talent-match/types";
import { CandidatePanel } from "./CandidatePanel";
import { CompanyPanel } from "./CompanyPanel";
import { makeCopy } from "./parts";

type Tab = "candidate" | "company";

/**
 * /talent-match: candidate talent reports from /api/talent-match (phase 1).
 * The company side shows a coming-soon state until phase 3
 * (docs/plans/2026-10-12-talent-match-report.md).
 */
export function TalentMatch({ zh }: { zh: boolean }) {
  const copy = makeCopy(zh);
  const { c } = copy;
  const [tab, setTab] = useState<Tab>("candidate");
  const [login, setLogin] = useState<string | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  // Handle handed over by the home search box's Match button (?github=).
  const [handoff, setHandoff] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchMe().then((me) => { if (live) setLogin(me.user?.login ?? null); });
    // Read after hydration so the static shell never depends on the query.
    Promise.resolve().then(() => {
      const github = new URLSearchParams(window.location.search).get("github")?.trim();
      if (live && github) setHandoff(github.slice(0, 39));
    });
    return () => { live = false; };
  }, []);

  const refreshQuota = useCallback(() => {
    getQuota().then((result) => { if (result.ok) setQuota(result.value); });
  }, []);
  useEffect(() => {
    if (login) refreshQuota();
  }, [login, refreshQuota]);
  const onSignIn = useCallback(() => signInWithGitHub(), []);
  // Unknown quota (still loading, or the read failed) never blocks: the API enforces it.
  const remaining = quota ? quota.limit - quota.used : null;

  const tabs: [Tab, string, typeof UserRound][] = [
    ["candidate", c("我是求职者", "I'm a candidate"), UserRound],
    ["company", c("我在招聘", "I'm hiring"), Building2],
  ];

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pb-20 pt-10 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-zinc-100 sm:text-3xl">{c("人才匹配", "Talent Match")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400 sm:text-base">
            {c(
              "上传简历或提供 GitHub，生成人才画像、匹配 DeepSeek 岗位，并告诉你下一步该贡献哪些开源项目、补哪些能力。",
              "Bring a résumé or your GitHub to get a talent profile, matching DeepSeek roles, and concrete next steps — which open-source projects to contribute to and which skills to build.",
            )}
          </p>
        </div>
        {tab === "candidate" && login && quota && remaining !== null && (
          <p className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-400">
            {c(`本月剩余 ${remaining} / ${quota.limit} 份报告`, `${remaining} of ${quota.limit} reports left this month`)}
          </p>
        )}
      </header>


      <div role="tablist" aria-label={c("使用身份", "I am")} className="mt-6 flex gap-2">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tm-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`tm-panel-${id}`}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm transition-colors ${
              tab === id ? "border-white/20 bg-white/5 font-semibold text-zinc-100" : "border-white/10 text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />{label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`tm-panel-${tab}`} aria-labelledby={`tm-tab-${tab}`} className="mt-5">
        {tab === "candidate" ? (
          <CandidatePanel copy={copy} login={login} handoff={handoff} canGenerate={remaining === null || remaining > 0} onQuotaChange={refreshQuota} onSignIn={onSignIn} />
        ) : (
          <CompanyPanel />
        )}
      </div>
    </main>
  );
}
