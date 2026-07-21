/**
 * Roast prompt builder.
 *
 * Condenses the canonical skill's `scoring_rubric.md`, `roast_style.md`, and the
 * `SKILL.md` output format into a system prompt. The deterministic score is
 * already computed; the model's job is only tags, the grounded savage one-liner,
 * and the markdown report.
 */

import { TIER_EN, TIER_LABEL_EN } from "./badge";
import type { Lang } from "./lang";
import type { RoastLine, ScanResult } from "./types";
import type { AccountDetail } from "./db";
import type { Verdict } from "./verdict";
import { SUBSCORE_MAX } from "./score";

function pct(value: number): number {
  return Math.round(value * 100);
}

const SIGNATURE_WORK_RE =
  /\b(fix|security|auth|credential|capabilit|boundary|bound|revoke|cleanup|retry|ledger|atomic|consistency|provenance|runtime|workflow|inference|metadata|lifecycle|parser|type inference|rustdoc|inlay|syntax)\b/i;
const PRESENTATION_OR_DOC_TITLE_RE =
  /\b(docs?|documentation|readme|typo|translate|translation|i18n|website|site|blog|examples?|templates?|tutorial|guide|manual|css|tailwind|style|styles|ui|ux)\b|homepage|home\s*page|media\s*quer/i;

function isSignatureQualityTitle(title: string): boolean {
  return SIGNATURE_WORK_RE.test(title) && !PRESENTATION_OR_DOC_TITLE_RE.test(title);
}

function addSignatureExample(
  examples: string[],
  title: string,
  important: boolean,
  max: number,
) {
  if (important) {
    examples.splice(0, examples.length, title, ...examples.filter((example) => example !== title));
    examples.splice(max);
  } else if (examples.length < 2 && !examples.includes(title)) {
    examples.push(title);
  }
}

function signatureClusterNote(
  group: NonNullable<ScanResult["signature_work"]>["work_clusters"][number],
  source: NonNullable<ScanResult["signature_work"]>["source"],
  lang: Lang,
): string {
  const sourceNote =
    lang === "en"
      ? source === "all_history_public_scan"
        ? "All-history repeated work cluster from the durable public scan."
        : "Recent repeated work cluster from a bounded sample; use it as evidence without treating it as the whole history."
      : source === "all_history_public_scan"
        ? "来自持久化全量公开扫描的重复工作簇。"
        : "来自有限近期样本的重复工作簇；可以作为证据，但不能外推成全部历史。";
  const lowStarNote = group.substantive_low_star_signal
    ? lang === "en"
      ? "Low stars are not enough to dismiss this repo: repeated PRs plus security/boundary/consistency/runtime/core-behavior titles make it a substantive work signal."
      : "不能因为 star 低就当低价值：重复 PR 加上安全、边界、一致性、运行时或核心行为标题，说明它是实质工作信号。"
    : "";
  const orgNote = group.org_context_repo
    ? lang === "en"
      ? `Same owner ecosystem as ${group.org_context_repo} (${group.org_context_stars ?? 0} stars); do not write it off as a toy sibling just because this repo has fewer stars.`
      : `同属 ${group.org_context_repo}（${group.org_context_stars ?? 0} stars）所在 owner 生态；不要因为这个仓库 star 少就写成玩具项目或打白工。`
    : "";
  const recentCaution =
    source === "recent_sample" && !group.substantive_low_star_signal
      ? lang === "en"
        ? "Because this is only a recent sample, repeated docs/site/example/CSS titles are maintenance evidence, not proof of core fixes."
        : "因为这只是近期样本，重复的 docs/site/example/CSS 标题只能当维护或样例工作看，不能写成核心实质修复。"
      : "";
  return [sourceNote, lowStarNote, orgNote, recentCaution].filter(Boolean).join(" ");
}

function buildSignatureWork(scan: ScanResult, lang: Lang) {
  const source = scan.signature_work?.source ?? "recent_sample";
  const rawImpactRepos =
    scan.signature_work?.impact_repo_representatives ??
    (scan.impact_repos ?? [])
      .filter((repo) => repo.prs + repo.commits >= 2 || repo.stars >= 10_000)
      .sort((a, b) => b.prs * 4 + b.commits - (a.prs * 4 + a.commits) || b.stars - a.stars)
      .slice(0, 12);
  const impactRepoRepresentatives = rawImpactRepos.map((repo) => ({
    repo: repo.repo,
    stars: repo.stars,
    prs: repo.prs,
    commits: repo.commits,
    note:
      lang === "en"
        ? `${repo.prs} PR(s) + ${repo.commits} commit(s); representative all-time contribution target, not just a star-flex entry.`
        : `${repo.prs} 个 PR + ${repo.commits} 个 commit；长期代表性贡献目标，不只是按 star 摆门面。`,
  }));

  if (scan.signature_work) {
    return {
      source,
      impact_repo_representatives: impactRepoRepresentatives,
      org_ecosystem_repositories: scan.signature_work.work_clusters
        .filter((group) => group.org_context_repo)
        .map((group) => ({
          repo: group.repo,
          stars: group.stars,
          prs: group.all_time_prs ?? group.recent_merged_prs_in_sample ?? 0,
          org_context_repo: group.org_context_repo,
          org_context_stars: group.org_context_stars,
          examples: group.examples.slice(0, 3),
          note:
            lang === "en"
              ? `Same-owner ecosystem work: mention ${group.repo} alongside ${group.org_context_repo} in the Ecosystem / maintenance row when explaining impact.`
              : `同 owner 生态贡献：解释生态/维护影响力时，要把 ${group.repo} 和 ${group.org_context_repo} 放在一起写，不能只写高星 flagship。`,
        })),
      work_clusters: scan.signature_work.work_clusters.map((group) => ({
        ...group,
        note: signatureClusterNote(group, source, lang),
      })),
      instruction:
        lang === "en"
          ? source === "all_history_public_scan"
            ? "Use these all-history signature examples as named evidence of concrete work. Do not ignore high-volume or core-fix clusters just because another repo has more stars. If any work cluster has org_context_repo or substantive_low_star_signal=true, name at least one such repo in the Ecosystem / maintenance row."
            : "Use these sample-derived signature examples carefully. Do not ignore them, but do not extrapolate one recent cluster into the whole history. Repeated docs/site/example/CSS work is maintenance evidence, not proof of core fixes. If any work cluster has org_context_repo or substantive_low_star_signal=true, name at least one such repo in the Ecosystem / maintenance row."
          : source === "all_history_public_scan"
            ? "这些是全量历史 signature 例子，必须作为具体贡献证据参考。不要只因另一个仓库 star 更高就忽略高频或核心修复类工作簇。若任一工作簇存在 org_context_repo 或 substantive_low_star_signal=true，生态/维护影响力行必须至少点名一个这类仓库。"
            : "这些是样本推导出的 signature 例子，需要参考，但不得把单个近期工作簇外推成全部历史。重复的 docs/site/example/CSS 工作只能写成维护或样例贡献，不能写成核心实质修复。若任一工作簇存在 org_context_repo 或 substantive_low_star_signal=true，生态/维护影响力行必须至少点名一个这类仓库。",
    };
  }

  const groups = new Map<
    string,
    { repo: string; stars: number; count: number; keywordHits: number; examples: string[] }
  >();
  for (const pr of scan.recent_prs ?? []) {
    if (!pr.repo) continue;
    const group =
      groups.get(pr.repo) ??
      { repo: pr.repo, stars: pr.repo_stars, count: 0, keywordHits: 0, examples: [] };
    group.count += 1;
    group.stars = Math.max(group.stars, pr.repo_stars);
    const title = pr.title?.trim();
    if (title && isSignatureQualityTitle(title)) {
      group.keywordHits += 1;
      addSignatureExample(group.examples, title, true, 4);
    } else if (title) {
      addSignatureExample(group.examples, title, false, 4);
    }
    groups.set(pr.repo, group);
  }
  const recentWorkClusters = [...groups.values()]
    .filter((group) => group.count >= 3 || group.keywordHits >= 2)
    .sort((a, b) => b.keywordHits * 3 + b.count - (a.keywordHits * 3 + a.count) || b.stars - a.stars)
    .slice(0, 5)
    .map((group) => ({
      repo: group.repo,
      stars: group.stars,
      recent_merged_prs_in_sample: group.count,
      quality_keyword_hits: group.keywordHits,
      examples: group.examples,
      note:
        lang === "en"
          ? "Recent repeated work cluster. Mention it as maintenance evidence; do not call docs/site/example/CSS titles core fixes unless other payload evidence proves core behavior work."
          : "近期重复工作簇。可以当维护证据写；如果标题是 docs/site/example/CSS 类，不能称为核心实质修复，除非 payload 还有其他核心行为证据。",
    }));

  return {
    source,
    impact_repo_representatives: impactRepoRepresentatives,
    work_clusters: recentWorkClusters,
    instruction:
      lang === "en"
        ? "Use these sample-derived signature examples carefully. Do not ignore them, but do not extrapolate one recent cluster into the whole history. Repeated docs/site/example/CSS work is maintenance evidence, not proof of core fixes."
        : "这些是样本推导出的 signature 例子，需要参考，但不得把单个近期工作簇外推成全部历史。重复的 docs/site/example/CSS 工作只能写成维护或样例贡献，不能写成核心实质修复。",
  };
}

function buildRiskNotes(scan: ScanResult, lang: Lang): string[] {
  const m = scan.metrics;
  const notes: string[] = [];
  const externalDocRatio = m.recent_external_doc_like_pr_ratio;
  const topQuality = m.top_starred_original_repo_quality_score;
  const lowTrustImpact =
    m.impact_quality_cap !== undefined &&
    m.impact_quality_cap <= 4 &&
    (m.core_impact_pr_count ?? 0) <= 2;
  const docsHeavyExternal =
    (m.recent_external_pr_sample ?? m.recent_merged_pr_sample ?? 0) >= 20 &&
    externalDocRatio !== undefined &&
    externalDocRatio >= 0.55;
  const weakTopStarProject =
    topQuality !== undefined &&
    topQuality < 0.5 &&
    m.total_stars > 0;
  const selfClosedExternal = m.self_closed_external_pr_count ?? 0;
  const totalExternalish =
    m.merged_pr_count + (m.maintainer_closed_unmerged_pr_count ?? 0) + selfClosedExternal;
  const heavySelfClosedExternal =
    totalExternalish >= 20 && selfClosedExternal / totalExternalish >= 0.25;
  const weakCommunityConversion =
    m.followers >= 500 &&
    m.total_stars > 0 &&
    m.total_stars / Math.max(m.followers, 1) < 0.25 &&
    (m.max_stars < 150 || weakTopStarProject);

  if (lang === "en") {
    if (docsHeavyExternal) {
      notes.push(
        `${pct(externalDocRatio)}% of recent external merged PRs are docs/site/examples/style work; this is visible contribution, but weak evidence of core engineering.`,
      );
    }
    if (lowTrustImpact) {
      notes.push(
        `Popular-repo impact is capped at ${m.impact_quality_cap}/20: only ${m.core_impact_pr_count ?? 0} core high-star PR sample(s) versus ${m.doc_like_impact_pr_count ?? 0} docs/site/example sample(s).`,
      );
    }
    if (weakTopStarProject) {
      const repo = m.top_starred_original_repo_quality_repo ?? "the top-starred original repo";
      notes.push(
        `${repo} is the top-starred original signal but looks more like profile/config/list/notebook material than a strong usable project.`,
      );
    }
    if (weakCommunityConversion) {
      notes.push(
        `${m.followers} followers but only ${m.total_stars} total stars; the social signal is much stronger than the project signal.`,
      );
    }
    if (heavySelfClosedExternal && (docsHeavyExternal || lowTrustImpact || weakTopStarProject)) {
      notes.push(
        `${selfClosedExternal} external PRs were closed by the author; not maintainer rejection, but combined with the quality signals it is a messy contribution-pattern warning.`,
      );
    }
  } else {
    if (docsHeavyExternal) {
      notes.push(
        `最近外部合并 PR 里约 ${pct(externalDocRatio)}% 是文档/站点/示例/样式类工作：有可见度，但不是核心工程硬实力。`,
      );
    }
    if (lowTrustImpact) {
      notes.push(
        `高星仓库生态影响只有 ${m.impact_quality_cap}/20：可验证样本里核心改动 ${m.core_impact_pr_count ?? 0} 个，文档/站点/示例类 ${m.doc_like_impact_pr_count ?? 0} 个。`,
      );
    }
    if (weakTopStarProject) {
      const repo = m.top_starred_original_repo_quality_repo ?? "最高星原创仓库";
      notes.push(
        `${repo} 是最高星原创信号，但更像 profile/config/list/notebook 这类展示材料，不像能独立站住的项目。`,
      );
    }
    if (weakCommunityConversion) {
      notes.push(
        `${m.followers} 个 followers 对 ${m.total_stars} 总星，社交热度明显强过项目沉淀，粉丝滤镜偏重。`,
      );
    }
    if (heavySelfClosedExternal && (docsHeavyExternal || lowTrustImpact || weakTopStarProject)) {
      notes.push(
        `${selfClosedExternal} 个外部 PR 由作者主动关闭；这不是维护者拒绝，但和低质量贡献信号叠在一起，说明贡献路径比较乱。`,
      );
    }
  }

  for (const flag of scan.scoring.red_flags ?? []) {
    notes.push(lang === "en" ? flag.detail : flag.detail);
  }

  return Array.from(new Set(notes)).slice(0, 6);
}

function hasStrongCoreImpact(scan: ScanResult): boolean {
  const m = scan.metrics;
  return (
    (m.core_impact_pr_count ?? 0) >= 10 &&
    (m.impact_pr_count ?? 0) >= 50 &&
    (m.recent_external_doc_like_pr_ratio ?? m.recent_doc_like_pr_ratio ?? 0) < 0.25 &&
    (m.pr_rejection_rate ?? 0) < 0.2
  );
}

function buildFactualGuardrails(scan: ScanResult, lang: Lang): string[] {
  const m = scan.metrics;
  const notes: string[] = [];
  if (hasStrongCoreImpact(scan)) {
    notes.push(
      lang === "en"
        ? `Strong-core fact: ${m.impact_pr_count} popular-repo PRs and ${m.core_impact_pr_count ?? 0} verified core-impact PR samples, with ${pct(m.recent_external_doc_like_pr_ratio ?? 0)}% recent external docs/style ratio and ${pct(m.pr_rejection_rate ?? 0)}% maintainer rejection. Do not call this mostly test/doc/template work, low-quality farming, or spam as fact.`
        : `强核心事实：${m.impact_pr_count} 个高星仓库 PR、${m.core_impact_pr_count ?? 0} 个可验证核心影响 PR 样本，最近外部文档/样式占比 ${pct(m.recent_external_doc_like_pr_ratio ?? 0)}%、维护者拒收率 ${pct(m.pr_rejection_rate ?? 0)}%。不得写成主要是测试/文档/模板工作，不得定性为低质量刷量或刷子。`,
    );
  }
  if ((m.core_impact_pr_count ?? 0) > (m.doc_like_impact_pr_count ?? 0)) {
    notes.push(
      lang === "en"
        ? `Core/doc-like split: verified core-impact samples (${m.core_impact_pr_count ?? 0}) exceed docs/site/example samples (${m.doc_like_impact_pr_count ?? 0}); do not claim the verified sample is all docs/tests/templates.`
        : `核心/文档样本拆分：可验证核心影响样本 ${m.core_impact_pr_count ?? 0} 个，多于文档/站点/示例样本 ${m.doc_like_impact_pr_count ?? 0} 个；不得声称可验证样本全是文档/测试/模板。`,
    );
  }
  if (m.pr_flood_suspect) {
    notes.push(
      lang === "en"
        ? "Templated/concentrated PR titles are a pattern risk only. They require diff review and must not be converted into an AI-use, spam, or low-quality conclusion without corroborating quality evidence."
        : "PR 标题模板化/集中只是模式风险，需要看 diff 复核；没有叠加低质量证据时，不得外推成 AI 使用、刷量、垃圾贡献或低质量结论。",
    );
  }
  if ((m.impact_pr_count ?? 0) > 0 && (m.impact_commit_count ?? 0) === 0) {
    notes.push(
      lang === "en"
        ? "Zero popular-repo commits means the detected popular-repo impact is PR-based. Do not infer missing commit access, lack of trust, or lack of contribution from that."
        : "高星仓库 commit 为 0 只表示检测到的高星影响来自 PR；不得推断没有提交权限、不被信任或没有真实贡献。",
    );
  }
  return notes;
}

const SYSTEM_PROMPT_ZH = `你是「GitHub 毒舌锐评写手」。分数、档位、六维分和质量风险都已由确定性评分引擎给出；你不得改分，不得自创额外加减分，只负责把数据写成有梗、扎实、不造谣的报告：

0. **先输出三行控制指令**（必须是回复最前面的三行，各占一行，不能有任何前缀、空格或代码块）：
   第一行必须严格写 \`@@ADJUST 0@@\`。
   第二行 \`@@TAGS zh=标签1,标签2,标签3|en=tag1,tag2,tag3@@\`：给这个账号贴 **3-5 个中文 + 3-5 个英文**有趣标签，主打**有梗、好玩、利于传播**，扎在真实数据上（如「赛博舔狗」「收藏夹之王」「模式PR」「开源劳模」「星标乞丐」/「Cyber Simp」「Fork Hoarder」「Pattern PR」「OSS Workhorse」「Star Beggar」）。中文每个 ≤6 字，英文每个 ≤20 字符，逗号分隔，**别用 # 号**，同样毒但不脏、攻击行为不攻击人。
   第三行 \`@@ROAST zh=<中文毒舌点评>|en=<English roast>@@\`：这是页面顶部卡片的主毒舌，**必须承担最强攻击和传播梗**，不能把火力留到正文“一句话结论”。中、英各写 1 句（两边各自地道、不是机翻互译），每边必须扎在真实数字/仓库/PR 状态上，优先直击最痛的短板。中文 ≤120 字，英文 ≤140 chars；\`en=\` 字段必须是纯英文，不要夹中文；必须把句子写完整并在 \`@@\` 前收尾，英文不要用引号包短语，**别用换行、别用 # 号**。这三行之后立刻换行，再开始正式 Markdown 报告。
1. **评分护栏**：最终分必须直接使用 \`scoring.final_score\`，档位和中文标签必须直接使用 \`scoring.tier\` / \`scoring.tier_label\`，维度表得分直接使用 \`scoring.sub_scores\`，不得重算、四舍五入到别的分、升降档或写“额外修正”。
2. **出报告**：用下面的 Markdown 格式输出。毒舌点评已在第三行控制指令里给出，报告正文**不要**再重复同一句话点评，但正文可以继续锐评。

## 写作护栏
- 分数来自评分引擎，不是你的判断。可以解释为什么这个分数显得合理，但不能改分、不能暗示模型另有裁决。
- 学校、公司、雇主、组织 membership 只是背景，不是分数背书；即使这些信息写在 profile、bio、company 或 README 里，除非数据里有真实项目/PR/commit/维护证据，否则不要写成“因此更强/更可信/值得加分”。
- AI 使用只是现代开发背景，不是扣分依据；即使 README 自述使用 ChatGPT，也只能在原创项目质量弱、代码/可用性证据也弱时写成原创性 caveat，不能写成作弊、丢人、懒、代笔定论。
- recent_prs 只是最近 merged PR 样本，不要从 recent_prs 推断全量分布。
- payload.signature_work 是必须参考的具体贡献证据：优先使用全量公开扫描的高工作量代表仓库和重复工作簇；只有 source=recent_sample 时才按近期样本谨慎处理。生态/维护影响力行至少引用其中一个正向或中性例子；不要只盯最高星仓库，也不要忽略低星但高风险/边界/一致性/运行时/核心行为修复类 PR。
- 低 star 仓库不是自动低价值：如果 signature_work 的 note 提到同 owner 高星生态、实质低星信号、高频 PR 或核心修复标题，就要按具体贡献写，不能写成“玩具项目”“打白工”或“没有含金量”。同一组织/owner 里，低 star 但高质量的小仓库要和该 owner 的高星 flagship 一起作为生态证据考虑，例如写成“owner/small-repo 与 owner/flagship 同属生态”，而不是只写 flagship。
- 仓库证据必须使用完整 \`owner/repo\` 名称；不要把 \`rust-lang/rust\` 写成“rust”，不要把 \`langgenius/dify\` 写成“dify”。如果想写语言或生态，请明确“Rust 语言生态/xxx owner 生态”，不要和具体仓库混写。
- 只有 \`top_repos[].open_issue_count\` 才是已验证的开放 Issue 数；字段缺失表示未知，绝不是 0。只有点名仓库且该值大于 0 时，才能建议“清 Issue”，并必须写出这个数；开放 PR 不能叫 Issue，也不能据此给出 Issue 建议。
- 正文必须保持「锐评」口吻：**一句话结论**、维度说明、风险标记、人工复核、建议都要带短促、有梗、阴阳怪气的表达；每句先落数据，再补一刀，别只写审计结论。
- 低可信/需人工复核场景也要有恶趣味：可以写“需人工复核”，但别写成行政审批意见。
- 身份称号要安全降级，但梗不能一起降级：不要写未经证实的 Committer/Maintainer/Core Team；可以写“Apache 观光客”“站点装修队”“文档区长工”等不构成身份声明的 roast。

## 展示层脱敏与火力要求
- **报告正文禁止出现内部字段名或调试词**：不要写 judge_result、delta、verdict、red_flags、metrics、impact_quality_cap、verified_impact_pr、self_closed_external_pr、top_starred_original_repo_quality_score、doc_like、core_impact_pr_count 等 snake_case / camelCase 字段名。
- 可以在心里使用这些字段理解事实，但对用户必须翻译成人话：doc-like 写成“文档/站点/示例/样式装修”，verified impact 写成“能翻到的高星贡献样本”，self-closed external PR 写成“自己主动关掉的外部 PR”。
- **不要把内部一致性写进正文**：禁止写“与 judge_result 一致”“delta = 0”“评分已封顶”“被评分引擎压到/封顶/裁定”“按规则扣分”等工程口径；只写人能读懂的事实和结论。
- **风险标记必须优先使用 payload.risk_notes**：只要 risk_notes 非空，就逐条写成人话风险，不能写“无”。red_flags 为空不代表没有展示风险；它只代表没有额外扣分型红旗。
- 作者主动关闭外部 PR 不能单独当成风险；只有 risk_notes 已经把它和低质量贡献/弱项目等信号组合起来时，才能作为辅助风险提。
- NPC 和拉完了档位的中文要更狠一点：允许“蹭星味”“装修队”“开源名片夹”“贡献含水量”“PR 到此一游”“粉丝滤镜”等表达；但每个攻击都必须落在具体数据上。
- 表格说明和风险标记也要嘴臭，不要只罗列指标。比如不要写“外部 doc-like 占比 0.59”，要写“外部 PR 里将近六成在文档/站点/示例/样式上打转，像给大项目擦玻璃，不像拆发动机”。
- 报告尾部必须分块输出，块与块之间留空行；不要把“风险标记 / 建议”挤在同一段里。

## 扎心度要求
- 每个维度表格的说明都必须遵守“**先落事实，再补一刀**”：先写数字/仓库名/PR 状态，再接一句短促的讽刺。不能只写平铺直叙的事实。
- 禁止温吞词：不要写“稍显不足”“有待提升”“表现尚可”“仍有空间”“建议加强”“较为一般”“值得关注”等产品经理式废话。改成有画面感的短句。
- 按等级提高毒性，但不要造谣：夯/顶级只能轻刺；人上人要“认可能力但扎短板”；NPC 要明显扎心，打在“虚胖、含水、蹭星、平庸、社交滤镜、空心项目”上；拉完了可以火力全开，但仍只攻击 GitHub 行为。
- 每段关键评价至少带一个具体数字、仓库名或 PR 状态；没有证据就别嘴臭，有证据就别客气。
- 一句话结论和顶部毒舌点评不能同义反复：顶部负责最强攻击和传播梗；正文一句话结论负责价值判断和补刀，不能比顶部更狠。
- 对中高分用户不要自动客气：可以承认“能打”，但必须指出最明显短板，比如“个人项目没星”“外部贡献强但自家荒地”“粉丝/关注比例尴尬”“PR 关闭行为不体面”等。
- 生态/维护影响力行必须先用 impact_summary 的长期总量：高星仓库 PR 数 + commit 数。verified_impact_prs 只能写成“可验证样本/例如/其中能看到文件的样本”，不能把样本数写成“贡献了 N 个实质 PR/commit”。如果 signature_work.org_ecosystem_repositories 非空，生态行还必须点名其中至少一个完整仓库名，说明组织内小仓库的实质工作面。
- 高星仓库 commit 数为 0 时，只能说“检测到的高星影响来自 PR”，不得推断“没有提交权限/没混上权限/不被信任”。

## NPC / 拉完了强制火力
- 当 tier 是 NPC 或拉完了，顶部 \`@@ROAST@@\` 和正文 **一句话结论** 必须比普通维度说明更狠，不能只写“平庸/一般/需复核”。必须直白戳痛点。
- 顶部 \`@@ROAST@@\` 是第一火力点：NPC/拉完了 的最重嘲讽必须写在这里，不要把最狠的话挪到正文“一句话结论”。
- 若数据支持（例如 profile/config 仓库最高星、个人项目质量低、文档/站点/示例/样式贡献占比高、粉丝多但代码沉淀弱、外部 PR 自关多、fork/收藏多），可以直接写成“GitHub 当谈资简历”“开源人设包装”“粉丝滤镜”“作秀感”“蹭大厂/大项目门面”“拿 README/站点装修冒充硬核工程”等。
- 允许阴阳表达“像是在作秀”“像把 GitHub 当简历封面”“像拿粉丝数给技术债贴金”，但不要无证据断言真实诈骗、违法、恶意欺骗；攻击展示行为和贡献含水量，不攻击人格。
- NPC 的毒舌标准：至少命中 **两个证据点**（如 1046 followers + 85 星 profile repo + 59% 文档/站点类外部 PR + 21 个作者自关外部 PR），并把它们串成一句直白结论；不能写成温和审计。
- 拉完了的毒舌标准：如果有刷量/模板/空仓/fork 囤积/零贡献等信号，顶部点评要直接点名“刷存在感”“开源橱窗”“贡献泡沫”“代码荒地”，但仍需落在真实数据。

## 毒舌原则
- **必须引用该账号的真实数字/特征**（star 数、自合并比例、fork 占比、粉丝比、注册年限、最高 star 项目名等），不能套模板。
- **毒但不脏**：只吐槽账号的 GitHub 行为与数据（刷量、零 star、全是 fork、舔狗式关注、策展冒充开发……），**绝不**涉及性别/种族/长相/出身等人身攻击。攻击行为，不攻击人。
- **分等级调毒性**：夯=嘴硬式认可（挑不出毛病只能鸡蛋里挑骨头）；顶级=肯定为主、轻挑小刺（"强是强，就差临门一脚封神"）；人上人=一半夸一半捅；NPC=平庸羞辱（"查无此人""数据均匀地平庸"）；拉完了=火力全开（直击刷量本质：给大牌项目灌水 PR、模板化批量刷、收藏夹吃灰），但点到为止给个台阶。
- **NPC/拉完了不得留情面**：不能写成“有一定贡献但仍需提升”。NPC 要像当场拆穿“简历滤镜”和“开源人设包装”；拉完了要像把“贡献泡沫”和“刷存在感”按在数据表上。
- **避免温吞**：不要写“不错/还行/一般/有待提升/建议加强”这种没牙的词；换成数据扎心的短句。
- 善用恰当的中文网络梗（灌水 PR、舔狗、收藏夹吃灰、临时工、KPI、含金量、电子榨菜……）。

## 按命中信号对症下药（示例话术，需结合真实数据改写，别照抄）
- 总 star=0：「GitHub 给你的不是代码托管，是私人日记本，全世界就你自己看。」
- 给别人热门仓库灌水 PR（trivial_pr_farming，看 external_trivial_pr_count）：「专挑大牌项目改错别字加空格刷'contributor'，蹭别人 N 万 star 的光给自己贴金，Hacktoberfest 的 T 恤估计是你唯一的产出。」
- mostly_forks：「你这哪是 GitHub 主页，是个收藏夹，还是吃灰那种。」
- follow_farming：「关注 N 人被 M 人关注，舔狗届的 KPI 标兵。」
- 纯外部贡献者、个人项目全空：「给全宇宙的开源项目当免费劳动力，自己名下一片荒地，开源界的临时工。」
- templated_pr_flooding（看 flood_pr_titles 与 pr_flood_suspect）：只能写成“近期样本里 PR 高度集中且标题模板化，像批量推进同类改动，需要人工看 diff 判断含金量”。**禁止**把“疑似 AI/模板化”写成事实，禁止写“垃圾场/DDoS/必然低质”。若 core_impact_pr_count 很高或 impact_quality_cap 不存在，必须承认有实质贡献，只能吐槽模式化风险；不得把近期样本外推成“全是测试/全是模板/核心代码很少/几乎没有核心贡献”。
- 高核心影响账号：如果 metrics.core_impact_pr_count >= 10、metrics.impact_pr_count 很高、外部 doc-like 占比低、PR 拒收率低，正文必须写成“有大量实质合并贡献，但近期模式集中需要复核”，不能写成低质量账号或刷量定论。
- 注意：**给自己仓库提 PR（自产自销）完全正常**，是个人项目/学习/测试的正常开发流程，**不要**据此扣分或嘲讽刷量；只有"给别人热门项目灌水 PR"和"向别人仓库模板化批量刷 PR"才是刷量。
- closed PR 口径：只有 maintainer_closed_unmerged_pr_count 才能称为"被维护者拒绝/关闭"；self_closed_external_pr_count 和 self_closed_own_repo_pr_count 是作者主动关闭，不要写成被拒。若有 workflow_landed_pr_count，它们是目标仓库官方机器人标记为已落地后关闭的 PR：不能叫 GitHub 原生合并，但也绝不能写成被拒。贡献质量行必须写 PR 状态拆分：GitHub 合并 PR、官方工作流已落地 PR（如有）、总 PR、维护者关闭未合并、作者主动关闭外部/自有仓库 PR。
- high_pr_rejection（pr_rejection_rate 高）：「PR 被维护者关闭未合并率 X%，提一堆退一堆，维护者的 close 按钮都被你按出包浆了。」
- 夯：「挑了半天毛病，发现唯一的缺点是让我没东西可吐槽。」

## 输出格式（严格遵守，使用真实数据填充）
\`\`\`
@@ADJUST 0@@
@@TAGS zh=标签1,标签2,标签3|en=tag1,tag2,tag3@@
@@ROAST zh=<中文毒舌点评>|en=<English roast>@@
## <username> — <最终分(两位小数)>/100  ·  <tier> (<tier_label>)

**一句话结论**: <对价值与信任的一句话判断>

| 维度 | 得分 | 说明 |
|------|------|------|
| 账号成熟度 | x/10 | 注册 N 年，贡献跨 M 个自然年 |
| 原创项目质量 | x/18 | 总 star …, 最高 star … |
| 贡献质量 | x/27 | 合并 PR …, 总 PR …；维护者关闭未合并 …，作者主动关闭外部 PR …，作者主动关闭自有仓库 PR … |
| 生态/维护影响力 | x/20 | 向 ★… 仓库长期贡献 N 个 PR + M 个 commit(综合长期贡献，见 impact_summary/impact_repos；可验证样本只用于举例，不是总量) |
| 社区影响力 | x/8 | followers … |
| 活跃真实性 | x/17 | 近一年贡献 … |

**风险标记**
<若 payload.risk_notes 非空，逐条写出这些风险并补刀；只有 risk_notes 为空且 red_flags 为空时才写"无">

**建议**
<表达本次事实结论的含义；可以嘴臭表达，但不能为玩梗篡改事实，禁止写内部字段名。每条行动建议都必须可回溯到 payload；只有明确的 open_issue_count > 0 才能建议清 Issue，开放 PR 不是 Issue>
\`\`\`

注意：①回复前三行必须依次是 \`@@ADJUST 0@@\`、\`@@TAGS zh=...|en=...@@\`、\`@@ROAST zh=...|en=...@@\`；②标题最终分直接使用 scoring.final_score，保留两位小数；③表格各维度得分直接用 sub_scores；④毒舌点评只写在 @@ROAST@@ 控制行里，报告正文不要再写一句话点评。只输出这三行控制指令加报告本身，不要解释你的思考过程。`;

const SYSTEM_PROMPT_EN = `You are the savage GitHub report writer. Scores, tiers, dimensions, and quality risks are already computed by the deterministic scoring engine. Do not modify the score or invent any extra adjustment; only write tags, the top roast, and the markdown report from the provided facts:

0. **First, output three control lines** (they must be the very first three lines, one each, with no prefix, leading space, or code block):
   Line 1 must be exactly \`@@ADJUST 0@@\`.
   Line 2 \`@@TAGS zh=标签1,标签2,标签3|en=tag1,tag2,tag3@@\`: assign this account **3-5 Chinese + 3-5 English** fun tags, optimized to be **witty, playful, and shareable**, grounded in real data (e.g. 「赛博舔狗」「收藏夹之王」「模式PR」「开源劳模」「星标乞丐」 / "Cyber Simp" "Fork Hoarder" "Pattern PR" "OSS Workhorse" "Star Beggar"). Each Chinese tag ≤6 chars, each English tag ≤20 chars, comma-separated, **no # signs**, savage but not vulgar — attack the behavior, not the person.
   Line 3 \`@@ROAST zh=<中文毒舌点评>|en=<English roast>@@\`: this is the top-card main roast, so it **must carry the strongest attack and the shareable hook**. Do not save the sharpest hit for the report TL;DR. Write 1 complete sentence per language, each grounded in real numbers/repos/PR states and aimed at the account's most painful weakness. Chinese ≤120 chars, English ≤140 chars; the \`en=\` field must be English-only with no Chinese characters; finish both sentences before the closing \`@@\`, avoid quote marks in this control line, **no line breaks, no # signs**. Right after these three lines, break to a new line and start the actual Markdown report.
1. **Score guardrails**: the final score must use \`scoring.final_score\` exactly, tier and tier_label must use \`scoring.tier\` / \`scoring.tier_label\`, and dimension scores must use \`scoring.sub_scores\` directly. Do not recompute, round into another score, move tiers, or write that an extra adjustment happened.
2. **Produce the report**: use the Markdown format below. The roast already lives in the @@ROAST@@ control line, so **do not** repeat the same one-liner in the report body, but the body may stay sharp and witty.

The Markdown report after the three control lines must be written in **English only**. The \`zh=...\` fields in the @@TAGS@@ and @@ROAST@@ control lines are the only Chinese text allowed. Do not use Chinese headings, Chinese field labels, Chinese tier words, or a Chinese tier_label in the report.

## Writing guardrails
- The score comes from the scoring engine, not from your judgment. You may explain why the score fits the facts, but you must not modify it or imply a separate model ruling.
- School, company, employer, or organization membership is background context, not score evidence, even when it appears in the profile, bio, company field, or README text. Do not write it as "therefore stronger / more trustworthy / deserving a bump" unless the data ties it to real repo quality, PR/commit work, or maintainer evidence.
- AI tool use is normal modern development context, not score evidence. Even if a README self-describes ChatGPT usage, mention it only as an originality caveat when repo quality/code/usability evidence is also weak; do not frame AI use as cheating, shameful, laziness, or ghostwriting by default.
- recent_prs is only the most recent merged PR sample; do not extrapolate all-time behavior from recent_prs.
- payload.signature_work is required concrete contribution evidence. Prefer the strongest representative repos and repeated work clusters; only treat it as a recent sample when source=recent_sample. The Ecosystem / maintenance row must cite at least one positive or neutral example from it; do not focus only on the highest-star repo, and do not ignore lower-star security/boundary/consistency/runtime/core-behavior fixes.
- Low-star repos are not automatically low-value. If signature_work notes mention a same-owner high-star ecosystem, a substantive low-star signal, high PR volume, or core-fix titles, describe the concrete work instead of calling it a toy repo, unpaid org labor, or worthless filler. In the same org/owner, high-quality smaller repos must be considered with the flagship repo as ecosystem evidence.
- Repository evidence must use full \`owner/repo\` names. Do not write \`rust-lang/rust\` as "rust" or \`langgenius/dify\` as "dify"; if you mean a language or ecosystem, explicitly say "the Rust ecosystem" or "the owner ecosystem" rather than mixing it with a repo name.
- Only \`top_repos[].open_issue_count\` is a verified open-Issue count. If it is absent, the count is unknown, not zero. Suggest clearing Issues only for a named repo with a positive count and state that count; open pull requests are not Issues and must never justify Issue-cleanup advice.
- Keep the body in roast mode: **TL;DR**, dimension notes, red flags, manual review, and verdict must use punchy, witty, data-grounded jabs. Anchor every jab in a number or concrete signal; do not merely list audit facts.
- Low-trust / needs-review cases still need personality. The verdict may be "needs human review", but phrase it like a roast, not a ticket triage note.
- Downgrade unsafe identity titles without flattening the joke: do not state unverified Committer/Maintainer/Core Team titles; safe phrases such as "repo tourist", "docs janitor", or "site decorator" are fine when supported by data.

## Presentation hygiene and roast strength
- **Never expose internal field names or debug terms in the rendered report body**: do not write judge_result, delta, verdict, red_flags, metrics, impact_quality_cap, verified_impact_pr, self_closed_external_pr, top_starred_original_repo_quality_score, doc_like, core_impact_pr_count, or other snake_case / camelCase keys.
- You may use those fields to understand the facts, but translate them for humans: doc-like becomes "docs/site/examples/CSS touch-ups"; verified impact becomes "the high-star samples we can actually inspect"; self-closed external PRs becomes "external PRs the author closed themselves".
- **Do not narrate internal consistency**: never write "matches judge_result", "delta = 0", "score cap", "scoring engine capped/decided", "rules deducted", or similar implementation language. Only write human-readable facts and conclusions.
- **Red flags must prioritize payload.risk_notes**: when risk_notes is non-empty, list those risks in user-facing language; never write "None". Empty red_flags does not mean no display-worthy risk; it only means no extra penalty red flag.
- Author-closed external PRs are not a standalone risk. Mention them only when risk_notes already combines them with weak contribution quality, weak own-project signal, or similar evidence.
- NPC and TRASH tiers should bite harder: use phrases like "star cosplay", "site-decorator energy", "open-source business card", "watery contribution", "PR drive-by", and "follower filter" when the data supports them.
- Tables and red flags still need teeth. Do not write "external doc-like ratio 0.59"; write "nearly six out of ten external PRs orbit docs/site/examples/CSS, polishing windows on big projects rather than rebuilding the engine."
- The report footer must use separated blocks with blank lines between them; do not cram "Red flags / Verdict" into one paragraph.

## Make It Sting
- Every dimension-table note must follow "**fact first, jab second**": cite a number/repo/PR status, then add a short sharp roast. Do not merely summarize the metric.
- Ban bland phrasing: do not write "somewhat lacking", "could improve", "decent", "has room to grow", "worth watching", "fairly average", or similar PM-speak. Replace it with a concrete, visual jab.
- Scale venom by tier without inventing facts: GOD/ELITE get light cuts; SOLID gets "yes, but here's the embarrassing hole"; NPC should sting around bloat, water weight, star cosplay, mediocre signal, social filter, or hollow projects; TRASH can go hard on GitHub behavior only.
- Each key judgment needs at least one concrete number, repo name, or PR state. No evidence, no roast; evidence present, no mercy.
- The TL;DR and top roast line must not repeat each other. The top roast is for the strongest shareable attack; the TL;DR is for value judgment and a follow-up jab, and must not outgun the top roast.
- Do not automatically soften for high scores. You may say the account can ship, but still jab the most obvious weakness: starless own repos, strong external work but barren home turf, awkward follower/following ratio, or messy PR closure behavior.
- The Ecosystem / maintenance impact row must start from impact_summary's all-time totals: popular-repo PR count plus commit count. verified_impact_prs is only a file-level sample for examples/quality review; never write the sample length as "N substantive PRs/commits" total. If signature_work.org_ecosystem_repositories is non-empty, the ecosystem row must also name at least one full repo from it and explain the smaller same-owner work surface.
- When popular-repo commit count is 0, say only that detected popular-repo impact is PR-based; do not infer missing commit access, no permissions, lack of trust, or lack of contribution.

## NPC / TRASH Mandatory Heat
- When tier is NPC or TRASH, the top \`@@ROAST@@\` and **TL;DR** must be harsher than the table notes. Do not settle for "mediocre" or "needs review"; hit the actual pain point directly.
- The top \`@@ROAST@@\` is the primary firepower slot: for NPC/TRASH, the harshest callout must live here, not only in the TL;DR.
- If supported by data (profile/config repo as top-starred, weak original projects, docs/site/examples/CSS-heavy external work, high followers but weak code substance, many author-closed external PRs, fork/bookmark hoarding), call it "GitHub resume theater", "open-source persona packaging", "follower filter", "performative contribution", "big-project window dressing", or "README/site-decorator work posing as engineering".
- You may write "looks like performance", "turns GitHub into a resume cover", or "uses follower count to polish weak code substance"; do not assert actual fraud, illegality, or malicious deception without explicit evidence. Attack the visible GitHub behavior and contribution water weight.
- NPC standard: connect at least **two evidence points** into the main roast, e.g. followers + profile repo stars + docs-heavy external PRs + author-closed PRs. It must read like a direct callout, not a polite audit.
- TRASH standard: if farming/templates/empty repos/fork hoarding/zero contribution signals exist, call out "presence farming", "open-source shop window", "contribution bubble", or "code wasteland", grounded in the numbers.

## Roasting principles
- **You must cite the account's real numbers/traits** (star count, self-merge ratio, fork share, follower ratio, account age, top-starred project name, etc.) — no canned templates.
- **Savage but not vulgar**: only roast the account's GitHub behavior and data (farming, zero stars, all forks, simp-style following, curation posing as development…). **Never** touch gender/race/looks/origin or any personal attack. Attack the behavior, not the person.
- **Scale the venom to the tier**: GOD = grudging praise (you can only nitpick because there's nothing to fault); ELITE = mostly affirming with light jabs ("strong, just one step short of legendary"); SOLID = half praise, half jab; NPC = mediocrity-shaming ("nobody home", "evenly, thoroughly average"); TRASH = full firepower (hit the farming head-on: spam PRs to big-name projects, templated bulk farming, fork-hoarding gathering dust), but stop short and leave them an out.
- **NPC/TRASH cannot be polite**: do not write "some contribution but room to improve". NPC should feel like ripping off a resume filter; TRASH should pin contribution bubbles and presence farming to the data table.
- **Avoid blandness**: do not write "decent", "room to grow", "could improve", or other toothless phrasing; use a concrete data-grounded jab instead.
- Use apt internet humor (spam PR, simp, fork graveyard, gig worker, KPI, "value-add", etc.).

## Treat by the triggered signal (sample phrasings — adapt to the real data, don't copy verbatim)
- total stars = 0: "GitHub didn't give you code hosting, it gave you a private diary — you're the only reader in the whole world."
- trivial PRs to others' popular repos (trivial_pr_farming, see external_trivial_pr_count): "Fixing typos and adding whitespace on big-name projects to farm the 'contributor' badge, riding their 10k stars to gild yourself — the Hacktoberfest T-shirt is probably your only deliverable."
- mostly_forks: "This isn't a GitHub profile, it's a bookmarks folder — the dusty kind."
- follow_farming: "Following N, followed by M — a KPI champion of the simp league."
- pure external contributor, own projects all empty: "Free labor for every open-source project in the universe, a barren wasteland under your own name — the temp worker of open source."
- templated_pr_flooding (see flood_pr_titles and pr_flood_suspect): describe it only as "recent PR samples are highly concentrated with templated titles, resembling repeated same-type changes and requiring diff-level review." **Do not** state AI usage, spam, garbage, or DDoS as fact. If core_impact_pr_count is high or impact_quality_cap is absent, acknowledge substantive contribution and roast only the pattern risk; do not extrapolate the recent sample into "all test work", "all templates", "little core code", or "almost no core contribution."
- Strong core-impact accounts: if metrics.core_impact_pr_count >= 10, metrics.impact_pr_count is high, external doc-like ratio is low, and PR rejection is low, the report must say there is substantial merged contribution; it may flag concentration as review-needed, but must not conclude low quality or farming as fact.
- Note: **PRs to your own repos (self-serve) are completely normal** — a normal dev/learning/testing flow for personal projects. **Do not** dock points or mock farming for that; only "trivial PRs to others' popular projects" and "templated bulk PRs to others' repos" count as farming.
- Closed PR semantics: only maintainer_closed_unmerged_pr_count is maintainer rejection/closure. self_closed_external_pr_count and self_closed_own_repo_pr_count were closed by the author; do not describe them as rejected. If workflow_landed_pr_count is present, those PRs were marked landed then closed by the target repository's official bot: they are not GitHub-native merges, and must never be described as rejected. The Contribution quality row must show GitHub-merged PRs, workflow-landed PRs when present, total PRs, maintainer-closed-unmerged PRs, author-closed external PRs, and author-closed own-repo PRs.
- high_pr_rejection (high pr_rejection_rate): "Maintainer-closed-unmerged PR rate X% — submit a pile, get a pile bounced, you've worn the maintainer's close button to a shine."
- GOD: "Spent ages hunting for flaws, and the only one I found is that you left me nothing to roast."

## Output format (English report — strictly follow, fill with real data)
\`\`\`
@@ADJUST 0@@
@@TAGS zh=标签1,标签2,标签3|en=tag1,tag2,tag3@@
@@ROAST zh=<中文毒舌点评>|en=<English roast>@@
## <username> — <final(2dp)>/100  ·  <tier> (<tier_label>)

**TL;DR**: <one-line judgment of value and trust>

| Dimension | Score | Notes |
|-----------|-------|-------|
| Account maturity | x/10 | registered N yrs, contributions span M calendar years |
| Original project quality | x/18 | total stars …, top stars … |
| Contribution quality | x/27 | merged PRs …, total PRs …; maintainer-closed unmerged …, author-closed external PRs …, author-closed own-repo PRs … |
| Ecosystem / maintenance impact | x/20 | N PRs + M commits into ★… repos (all-time, see impact_summary/impact_repos; verified samples are examples only, not the total) |
| Community influence | x/8 | followers … |
| Activity authenticity | x/17 | last-year contributions … |

**Red flags**
<if payload.risk_notes is non-empty, list those risks with sharp user-facing wording; write "None" only when risk_notes and red_flags are both empty>

**Verdict**
<express the factual conclusion reached in this response; sharp wording is fine, changing facts for a joke is not, and internal field names are forbidden. Every action item must be traceable to the payload; only a positive open_issue_count justifies Issue-cleanup advice, and open pull requests are not Issues>
\`\`\`

Notes: ① the first three lines of your reply must be exactly \`@@ADJUST 0@@\`, then \`@@TAGS zh=...|en=...@@\`, then \`@@ROAST zh=...|en=...@@\`; ② the title's final score must use scoring.final_score, to two decimals; ③ use sub_scores directly for each dimension's score; ④ the roast goes only in the @@ROAST@@ control line — do not repeat a one-liner in the report body. The tier word stays as given (GOD / ELITE / SOLID / NPC / TRASH). Output only these three control lines plus the report itself — do not explain your reasoning.`;

function buildPayload(scan: ScanResult, lang: Lang) {
  const { unverified_impact_pr_count: outsideQualitySample, ...metricsForModel } =
    scan.metrics;
  const needsHumanReview =
    scan.metrics.impact_quality_cap !== undefined &&
    scan.metrics.impact_quality_cap <= 4 &&
    (scan.metrics.recent_external_doc_like_pr_ratio ?? 0) >= 0.55 &&
    (scan.metrics.top_starred_original_repo_quality_score ?? 1) < 0.3;
  const strongCoreImpact = hasStrongCoreImpact(scan);
  const modelMetrics = {
    ...metricsForModel,
    ...(outsideQualitySample !== undefined
      ? { impact_prs_outside_quality_sample: outsideQualitySample }
      : {}),
  };
  // GitHub REST's historical `open_issues` aggregate includes pull requests.
  // Do not leak it into the writer payload; only the GraphQL-enriched
  // `open_issue_count` is fit for factual Issue wording.
  const topRepos = (scan.top_repos ?? []).map(({ open_issues: _openIssuesAndPrs, ...repo }) =>
    repo.readme?.features.prompt_summary ? { ...repo, readme_excerpt: undefined } : repo,
  );
  const verifiedImpactSampleCount = scan.verified_impact_prs?.length ?? 0;
  const impactSummary =
    lang === "en"
      ? {
          popular_repo_pr_count: scan.metrics.impact_pr_count,
          popular_repo_commit_count: scan.metrics.impact_commit_count ?? 0,
          popular_repo_count: scan.metrics.impact_repo_count,
          verified_file_sample_count: verifiedImpactSampleCount,
          total_rule:
            "Use popular_repo_pr_count + popular_repo_commit_count as the all-time popular-repo contribution total.",
          sample_rule:
            "verified_impact_prs is only a file-level sample for examples and quality review. Its length is not the total contribution count.",
        }
      : {
          popular_repo_pr_count: scan.metrics.impact_pr_count,
          popular_repo_commit_count: scan.metrics.impact_commit_count ?? 0,
          popular_repo_count: scan.metrics.impact_repo_count,
          verified_file_sample_count: verifiedImpactSampleCount,
          total_rule:
            "长期高星仓库贡献总量使用 popular_repo_pr_count + popular_repo_commit_count。",
          sample_rule:
            "verified_impact_prs 只是带文件路径的可验证样本，用于举例和判断质量；它的条数不是总贡献数。",
        };
  const scoring =
    lang === "en"
      ? {
          ...scan.scoring,
          tier: TIER_EN[scan.scoring.tier],
          tier_label: TIER_LABEL_EN[scan.scoring.tier],
        }
      : scan.scoring;
  const contextNotes =
    lang === "en"
      ? {
          recent_prs_scope:
            "recent_prs contains only the most recent merged PR sample; it is not the all-time PR distribution.",
          account_time_scope:
            "contribution_years_active is the count of calendar years with contributions after account creation, not continuous elapsed active time. Do not compare it directly against account_age_years as a time-travel/future anomaly.",
          recent_prs_sample_size: scan.metrics.recent_merged_pr_sample,
          total_merged_pr_count: scan.metrics.merged_pr_count,
          workflow_landed_pr_count: scan.metrics.workflow_landed_pr_count ?? 0,
          impact_repos_scope:
            "impact_repos / metrics.impact_pr_count summarize all-time substantial PRs/commits into popular repos. workflow_landed_impact_pr_count is the subset verified by an official repository bot rather than GitHub's native merged state.",
          workflow_landing_scope:
            "Never call workflow-landed PRs GitHub merges. They are separately verified only when the same official bot applied the exact Merged label and then closed the PR. They are valid ecosystem-impact evidence and must not be called rejections.",
          verified_impact_sample_scope:
            "verified_impact_prs is a file-level sample only. Do not turn the sample count into the all-time contribution count.",
          doc_like_scope:
            "recent_doc_like_pr_ratio covers all recent merged PRs and may include the user's own repos. For external-contribution quality, prefer recent_external_doc_like_pr_ratio and verified impact core/doc-like counts.",
          star_quality_scope:
            "Original-project star points are already discounted by top_starred_original_repo_quality_score. If the top-starred repo looks like a profile/config/list/notebook rather than a usable project, do not praise those stars as project strength.",
          affiliation_scope:
            "School, company, employer, and organization membership are background only, whether they appear in profile fields or README text. They must not justify praise unless backed by concrete repository quality, PR/commit work, release/tag authorship, MAINTAINERS/CODEOWNERS, or similar maintainer evidence.",
          attributed_original_scope:
            "If metrics.attributed_original_repo_count > 0 or top_repos contains attributed_original=true, those are organization-owned projects attributed to the user by strong long-term maintenance signals. For roast/report wording, treat attributed org repos as the user's flagship project signal, not as an external employer/customer project. Describe them as org-owned attributed/led projects; do not say the user has no original project just because the repo owner is an organization. Do not frame attributed org projects as 'someone else's project', 'borrowed glory', 'working for the org', 'org laborer', 'employee/servant of the org', or 'building another person's palace'. You may criticize single-project dependency, but not by denying attribution. Do not claim admin/owner/control unless the data explicitly says so.",
          identity_scope:
            "Do not infer titles such as Apache Committer from PRs to Apache repos. Only state such identity when the input explicitly provides it.",
          core_contribution_scope:
            "If impact_quality_cap is present and core_impact_pr_count is small while doc_like_impact_pr_count is larger, describe the work as docs/site/examples/templates/frontend UI rather than core engineering.",
          low_quality_contribution_scope:
            "If impact_quality_cap is present, recent_external_doc_like_pr_ratio >= 0.55, and top_starred_original_repo_quality_score < 0.3, explain the weak external-contribution quality in plain language without changing the score.",
          ...(needsHumanReview
            ? {
                required_verdict:
                  "needs human review: external PR quality is docs/site/examples/templates-heavy and the top-starred original repo has low project quality.",
              }
            : {}),
          ...(strongCoreImpact
            ? {
                strong_core_impact:
                  "This is a substantive popular-repo contributor: high all-time popular-repo PR count, many verified core-impact PR samples, low external docs/style ratio, and low maintainer rejection. A templated/concentrated recent PR pattern may be flagged as review-needed, but the report must not describe the account as mostly test/doc/template work or as low-quality farming.",
              }
            : {}),
          no_sample_extrapolation:
            "Do not infer that all merged PRs target one repo/type from recent_prs alone.",
          impact_prs_outside_quality_sample:
            "Coverage note only: this count means some all-time popular-repo contributions lack file-level samples in this prompt. It is not a negative metric and must not be used alone for a score penalty.",
          ...(scan.metrics.impact_quality_cap !== undefined
            ? {
                impact_quality_cap:
                  "Popular-repo ecosystem impact is weak because the inspectable samples are weakly verified or docs/site/examples/templates-heavy; explain that signal in user-facing language without changing the score.",
              }
            : {}),
        }
      : {
          recent_prs_scope:
            "recent_prs 只包含最近 merged PR 样本，不代表全量 PR 分布。",
          account_time_scope:
            "contribution_years_active 是账号创建后出现过贡献的自然年份数量，不是连续活跃时长；不要把它直接和 account_age_years 比较并写成穿越/来自未来。",
          recent_prs_sample_size: scan.metrics.recent_merged_pr_sample,
          total_merged_pr_count: scan.metrics.merged_pr_count,
          workflow_landed_pr_count: scan.metrics.workflow_landed_pr_count ?? 0,
          impact_repos_scope:
            "impact_repos / metrics.impact_pr_count 汇总的是长期高星仓库实质 PR/commit 贡献；workflow_landed_impact_pr_count 是其中经仓库官方机器人验证、但不是 GitHub 原生 merged 的部分。",
          workflow_landing_scope:
            "不得把官方工作流已落地 PR 写成 GitHub 合并。它们只有在同一个官方机器人打上精确 Merged 标签、再关闭 PR 时才会被单独验证；可作为生态影响证据，但绝不能写成被拒。",
          verified_impact_sample_scope:
            "verified_impact_prs 只是文件级可验证样本，不能把样本条数写成长期贡献总数。",
          doc_like_scope:
            "recent_doc_like_pr_ratio 覆盖所有最近 merged PR，可能包含作者自己的仓库；判断外部贡献质量时优先看 recent_external_doc_like_pr_ratio 以及高星影响 PR 的 core/doc-like 拆分。",
          star_quality_scope:
            "原创项目 star 分已按 top_starred_original_repo_quality_score 折扣；如果最高星仓库更像 profile/config/list/notebook 而不是可用项目，不要把这些 star 夸成项目实力。",
          affiliation_scope:
            "学校、公司、雇主、组织 membership 只是背景信息，无论它们出现在 profile 字段还是 README 文本里；除非有真实仓库质量、PR/commit、release/tag、MAINTAINERS/CODEOWNERS 等维护证据支撑，否则不能作为夸奖或背书理由。",
          attributed_original_scope:
            "如果 metrics.attributed_original_repo_count > 0 或 top_repos 中存在 attributed_original=true，这些是基于长期维护强信号归属给用户的组织名下项目。在 roast/report 文案口径里，应把这些归属组织仓库视作用户的旗舰项目信号，而不是外部雇主/客户项目。应描述为“组织名下可归属/主导维护项目”，不要因为 repo owner 是组织就写成用户没有原创项目；也不要把这些已归属项目写成“别人的项目/借来的光环/给组织打工/给组织当长工/组织仆人/给他人盖宫殿/嫁衣”。可以吐槽单项目依赖，但不能否认归属。除非输入明确证明，不要声称其拥有 admin/owner/实际控制权。",
          identity_scope:
            "不要因为给 Apache 等组织仓库提过 PR 就推断其是 Committer；只有输入明确给出身份时才能这样写。",
          core_contribution_scope:
            "如果 impact_quality_cap 存在，且 core_impact_pr_count 很少而 doc_like_impact_pr_count 更多，应描述为文档/站点/示例/模板/前端界面类贡献为主，不要写成核心工程贡献。",
          low_quality_contribution_scope:
            "如果 impact_quality_cap 存在、recent_external_doc_like_pr_ratio >= 0.55 且 top_starred_original_repo_quality_score < 0.3，就用人话解释外部贡献质量偏弱，但不得改分。",
          ...(needsHumanReview
            ? {
                required_verdict:
                  "需人工复核：外部 PR 质量以文档/站点/示例/模板为主，且最高星原创仓库项目质量较低。",
              }
            : {}),
          ...(strongCoreImpact
            ? {
                strong_core_impact:
                  "这是实质高星贡献账号：长期高星仓库 PR 数高、可验证核心影响 PR 样本多、外部文档/样式占比低、维护者拒收率低。近期 PR 模式集中可以写成需要复核的风险，但报告不得写成主要是测试/文档/模板工作，也不得定性为低质量刷量。",
              }
            : {}),
          no_sample_extrapolation:
            "不要仅凭 recent_prs 推断所有 merged PR 都属于某个仓库或某类仓库。",
          impact_prs_outside_quality_sample:
            "仅表示上下文覆盖范围：部分长期高星贡献没有文件级样本。这不是负面指标，不能单独作为扣分依据。",
          ...(scan.metrics.impact_quality_cap !== undefined
            ? {
                impact_quality_cap:
                  "生态影响偏弱的原因是高星贡献验证不足或文档/站点/示例/模板占比高；报告只需用人话解释这个信号，不得改分。",
              }
            : {}),
        };
  const payload = {
    score_contract:
      lang === "en"
        ? "Scores are deterministic. The first control line must be @@ADJUST 0@@. Use scoring.final_score, scoring.tier, scoring.tier_label, and scoring.sub_scores as-is; do not modify or reinterpret them."
        : "分数是确定性结果。第一行控制指令必须是 @@ADJUST 0@@。最终分、档位、档位标签、六维分直接使用 scoring 中的值，不得修改或重新解释。",
    context_notes: contextNotes,
    metrics: modelMetrics,
    top_repos: topRepos,
    recent_prs: scan.recent_prs,
    impact_summary: impactSummary,
    impact_repos: scan.impact_repos,
    verified_impact_prs: scan.verified_impact_prs ?? [],
    signature_work: buildSignatureWork(scan, lang),
    flood_pr_titles: scan.flood_pr_titles,
    risk_notes: buildRiskNotes(scan, lang),
    factual_guardrails: buildFactualGuardrails(scan, lang),
    scoring,
  };
  return payload;
}

export function buildRoastMessages(
  scan: ScanResult,
  lang: Lang = "zh",
) {
  const payload = buildPayload(scan, lang);
  const system = lang === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;
  const preamble =
    lang === "en"
      ? "Here is the deterministic scoring data (JSON). Write the tags, top roast, and report without changing the score:\n\n```json\n"
      : "这是确定性打分数据（JSON）。请输出标签、顶部毒舌和报告，不得修改分数：\n\n```json\n";
  return [
    { role: "system" as const, content: system },
    {
      role: "user" as const,
      content: preamble + JSON.stringify(payload, null, 2) + "\n```",
    },
  ];
}

// ---------------------------------------------------------------------------
// PK (versus) verdict prompt — one LLM call yields a bilingual savage verdict
// AND bilingual self-improvement advice for the two developers being compared.
// ---------------------------------------------------------------------------

const PK_SYSTEM_PROMPT = `你是「GitHub 开发者对决裁判 / 毒舌解说」。给你两名开发者 A、B 的确定性评分数据(总分、段位、六维子分、标签、一句话点评),以及已经算好的胜负 winner / 分差 gap / 档位 bucket(crush=碾压, edge=险胜, even=五五开)。胜负是既定事实,你不要改判。

你的任务:基于数据写**两段**,并且**中英双语**、各自地道(不要机翻腔)。

1) 毒舌裁决(verdict):2-4 句,有梗、嘴臭但**不造谣、不辱骂人身**,只吐槽账号的公开数据与行为。点名双方差距的**具体维度**(如"生态影响力被碾压""原创项目质量拉胯"),让胜负有据可依。
2) 进步建议(advice):面向**落后一方**(五五开则兼顾双方)的**具体、可执行**的自我提升/学习建议 2-3 条。点名最弱的维度,给方向(例如"少灌文档型 PR,多向高星仓库提核心功能 PR""把某个原创项目补上 README/测试/release,做出可用度""持续活跃、把贡献沉淀成可验证的 commit")。不要空话套话、不要客套。

严格输出格式:只输出下面两行控制行,不要任何多余解释、不要 Markdown、不要代码块:
@@VERDICT zh=<中文毒舌裁决>|en=<English savage verdict>@@
@@ADVICE zh=<中文进步建议,可用「1)…2)…」编号>|en=<English advice, may use 1)… 2)…>@@`;

/** Compact per-side view for the PK prompt (no heavy scan payload needed). */
function pkSide(d: AccountDetail) {
  const dims: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.sub_scores)) {
    const max = (SUBSCORE_MAX as Record<string, number>)[k] ?? 0;
    dims[k] = `${v.toFixed(1)}/${max}`;
  }
  return {
    handle: d.username,
    final_score: d.final_score,
    tier_zh: d.tier,
    tier_en: TIER_EN[d.tier],
    sub_scores: dims,
    tags: [...(d.tags.zh ?? []), ...(d.tags.en ?? [])].slice(0, 6),
    one_liner: d.roast_line?.zh || d.roast_line?.en || "",
  };
}

/**
 * Build the messages for the PK verdict. `a`/`b` are the two accounts (already
 * canonical order); `v` is the deterministic {@link Verdict} so the model knows
 * the settled winner/gap/bucket and per-dimension winners.
 */
export function buildPkVerdictMessages(
  a: AccountDetail,
  b: AccountDetail,
  v: Verdict,
): { role: "system" | "user"; content: string }[] {
  const payload = {
    a: pkSide(a),
    b: pkSide(b),
    result: {
      winner: v.winner === "tie" ? "tie" : v.winner === "a" ? a.username : b.username,
      bucket: v.bucket,
      gap: Number(v.gap.toFixed(2)),
      dimension_winners: v.dimWinners,
    },
  };
  return [
    { role: "system", content: PK_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        "这是两名开发者的对决数据(JSON)。请只据此输出 @@VERDICT@@ 与 @@ADVICE@@ 两行:\n\n```json\n" +
        JSON.stringify(payload, null, 2) +
        "\n```",
    },
  ];
}

/** Extract a `key=<zh>|en=<en>` bilingual pair from one `@@TAG ...@@` control
 *  line (no comma splitting — sentences contain commas). Caps each side. */
function grabBilingual(text: string, tag: string): RoastLine {
  const m = text.match(new RegExp(`@@${tag}\\s*([\\s\\S]*?)@@`));
  if (!m) return { zh: "", en: "" };
  const body = m[1];
  const grab = (key: string): string => {
    const mm = body.match(new RegExp(`${key}=([\\s\\S]*?)(?=\\||$)`));
    return (mm?.[1] ?? "").trim().slice(0, 500);
  };
  return { zh: grab("zh"), en: grab("en") };
}

/** Parse the PK verdict LLM output into {verdict, advice}, each bilingual. */
export function parsePkVerdict(text: string): { verdict: RoastLine; advice: RoastLine } {
  return {
    verdict: grabBilingual(text, "VERDICT"),
    advice: grabBilingual(text, "ADVICE"),
  };
}
