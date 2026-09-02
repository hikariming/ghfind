package backend

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
)

// buildRoastPrompt is a faithful Go port of main's buildRoastMessages
// (src/lib/prompt.ts). The system prompts live in roast_prompt_text.go and are
// byte-identical with main; the payload below mirrors main's buildPayload key
// set and content item by item.
func buildRoastPrompt(scan ScanResult, language roastLanguage) []LLMMessage {
	payload := roastPromptPayload(scan, language)
	encoded, _ := json.MarshalIndent(payload, "", "  ")
	system, preamble := roastSystemZH, "这是确定性打分数据（JSON）。请输出标签、顶部毒舌和报告，不得修改分数：\n\n```json\n"
	if language == roastLanguageEN {
		system, preamble = roastSystemEN, "Here is the deterministic scoring data (JSON). Write the tags, top roast, and report without changing the score:\n\n```json\n"
	}
	return []LLMMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: preamble + string(encoded) + "\n```"},
	}
}

// pct mirrors main's `Math.round(value * 100)` percentage helper.
func pct(value float64) int {
	return int(math.Round(value * 100))
}

func roastPromptPayload(scan ScanResult, language roastLanguage) map[string]any {
	metrics := roastJSONMap(scan.Metrics)
	// Main renames the coverage-only count so the writer never treats it as a
	// quality signal: unverified_impact_pr_count leaves the payload and
	// impact_prs_outside_quality_sample (plus a context note) replaces it.
	delete(metrics, "unverified_impact_pr_count")
	if scan.Metrics.UnverifiedImpactPRCount != nil {
		metrics["impact_prs_outside_quality_sample"] = *scan.Metrics.UnverifiedImpactPRCount
	}
	topRepos := make([]map[string]any, 0, len(scan.TopRepos))
	for _, repo := range scan.TopRepos {
		item := roastJSONMap(repo)
		// GitHub's historical open_issues aggregate includes pull requests;
		// only the GraphQL-enriched open_issue_count is fact-safe wording.
		delete(item, "open_issues")
		if readme, ok := item["readme"].(map[string]any); ok {
			if features, ok := readme["features"].(map[string]any); ok && features["prompt_summary"] != "" {
				delete(item, "readme_excerpt")
			}
		}
		topRepos = append(topRepos, item)
	}
	impactSummary := map[string]any{
		"popular_repo_pr_count":      scan.Metrics.ImpactPRCount,
		"popular_repo_commit_count":  valueOrZero(scan.Metrics.ImpactCommitCount),
		"popular_repo_count":         scan.Metrics.ImpactRepoCount,
		"verified_file_sample_count": len(scan.VerifiedImpactPRs),
	}
	if language == roastLanguageEN {
		impactSummary["total_rule"] = "Use popular_repo_pr_count + popular_repo_commit_count as the all-time popular-repo contribution total."
		impactSummary["sample_rule"] = "verified_impact_prs is only a file-level sample for examples and quality review. Its length is not the total contribution count."
	} else {
		impactSummary["total_rule"] = "长期高星仓库贡献总量使用 popular_repo_pr_count + popular_repo_commit_count。"
		impactSummary["sample_rule"] = "verified_impact_prs 只是带文件路径的可验证样本，用于举例和判断质量；它的条数不是总贡献数。"
	}
	scoring := roastJSONMap(scan.Scoring)
	if language == roastLanguageEN {
		scoring["tier"] = englishTierName(scan.Scoring.Tier)
		scoring["tier_label"] = englishTierLabel(scan.Scoring.Tier)
	}
	scoreContract := "分数是确定性结果。第一行控制指令必须是 @@ADJUST 0@@。最终分、档位、档位标签、六维分直接使用 scoring 中的值，不得修改或重新解释。"
	if language == roastLanguageEN {
		scoreContract = "Scores are deterministic. The first control line must be @@ADJUST 0@@. Use scoring.final_score, scoring.tier, scoring.tier_label, and scoring.sub_scores as-is; do not modify or reinterpret them."
	}
	verifiedImpactPRs := scan.VerifiedImpactPRs
	if verifiedImpactPRs == nil {
		verifiedImpactPRs = []RecentPR{}
	}
	return map[string]any{
		"score_contract":                scoreContract,
		"context_notes":                 roastContextNotes(scan, language),
		"metrics":                       metrics,
		"top_repos":                     topRepos,
		"recent_prs":                    scan.RecentPRs,
		"impact_summary":                impactSummary,
		"impact_repos":                  scan.ImpactRepos,
		"verified_impact_prs":           verifiedImpactPRs,
		"signature_work":                roastSignatureWork(scan, language),
		"organization_maintained_repos": roastOrganizationMaintainedRepos(scan),
		"flood_pr_titles":               scan.FloodPRTitles,
		"risk_notes":                    roastRiskNotes(scan, language),
		"factual_guardrails":            roastFactualGuardrails(scan, language),
		"scoring":                       scoring,
	}
}

func roastJSONMap(value any) map[string]any {
	encoded, _ := json.Marshal(value)
	result := map[string]any{}
	_ = json.Unmarshal(encoded, &result)
	return result
}

// roastNeedsHumanReview mirrors main's needsHumanReview flag in buildPayload.
func roastNeedsHumanReview(scan ScanResult) bool {
	m := scan.Metrics
	return m.ImpactQualityCap != nil && *m.ImpactQualityCap <= 4 &&
		valueOrZero(m.RecentExternalDocLikePRRatio) >= 0.55 &&
		valueOr(m.TopStarredOriginalRepoQualityScore, 1) < 0.3
}

func roastContextNotes(scan ScanResult, language roastLanguage) map[string]any {
	m := scan.Metrics
	needsHumanReview := roastNeedsHumanReview(scan)
	strongCore := strongCoreImpact(scan)
	var notes map[string]any
	if language == roastLanguageEN {
		notes = map[string]any{
			"recent_prs_scope":                  "recent_prs contains only the most recent merged PR sample; it is not the all-time PR distribution.",
			"account_time_scope":                "contribution_years_active is the count of calendar years with contributions after account creation, not continuous elapsed active time. Do not compare it directly against account_age_years as a time-travel/future anomaly.",
			"last_year_contributions_scope":     "last_year_contributions is the aggregate count from GitHub's trailing-year contribution calendar and may include commits, PRs, issues, reviews, and other counted activity. It is not a PR count and does not provide repository-ownership distribution. Never attribute the entire value to PRs, commits, external repositories, or the user's own repositories; use only explicit breakdown fields in the payload.",
			"recent_prs_sample_size":            m.RecentMergedPRSample,
			"total_merged_pr_count":             m.MergedPRCount,
			"workflow_landed_pr_count":          valueOrZero(m.WorkflowLandedPRCount),
			"impact_repos_scope":                "impact_repos / metrics.impact_pr_count summarize all-time substantial PRs/commits into popular repos. workflow_landed_impact_pr_count is the subset verified by an official repository bot rather than GitHub's native merged state.",
			"workflow_landing_scope":            "Never call workflow-landed PRs GitHub merges. They are separately verified only when the same official bot applied the exact Merged label and then closed the PR. They are valid ecosystem-impact evidence and must not be called rejections.",
			"verified_impact_sample_scope":      "verified_impact_prs is a file-level sample only. Do not turn the sample count into the all-time contribution count.",
			"doc_like_scope":                    "recent_doc_like_pr_ratio covers all recent merged PRs and may include the user's own repos. For external-contribution quality, prefer recent_external_doc_like_pr_ratio and verified impact core/doc-like counts.",
			"star_quality_scope":                "Original-project star points are already discounted by top_starred_original_repo_quality_score. If the top-starred repo looks like a profile/config/list/notebook rather than a usable project, do not praise those stars as project strength.",
			"affiliation_scope":                 "School, company, employer, and organization membership are background only, whether they appear in profile fields or README text. They must not justify praise unless backed by concrete repository quality, PR/commit work, release/tag authorship, MAINTAINERS/CODEOWNERS, or similar maintainer evidence.",
			"attributed_original_scope":         "If metrics.attributed_original_repo_count > 0 or top_repos contains attributed_original=true, those are organization-owned projects attributed to the user by strong long-term maintenance signals. For roast/report wording, treat attributed org repos as the user's flagship project signal, not as an external employer/customer project. Describe them as org-owned attributed/led projects; do not say the user has no original project just because the repo owner is an organization. Do not frame attributed org projects as 'someone else's project', 'borrowed glory', 'working for the org', 'org laborer', 'employee/servant of the org', or 'building another person's palace'. You may criticize single-project dependency, but not by denying attribution. Do not claim admin/owner/control unless the data explicitly says so.",
			"organization_maintained_scope":     "organization_maintained_repos contains display-only public organization work with the existing long-term contribution threshold plus repository-local maintainer proof. It is not a score input and does not prove ownership, admin access, employment, or control. You may cite the exact repo and evidence, but never call it the user's personal repository or change the score because of it.",
			"identity_scope":                    "Do not infer titles such as Apache Committer from PRs to Apache repos. Only state such identity when the input explicitly provides it.",
			"core_contribution_scope":           "If impact_quality_cap is present and core_impact_pr_count is small while doc_like_impact_pr_count is larger, describe the work as docs/site/examples/templates/frontend UI rather than core engineering.",
			"low_quality_contribution_scope":    "If impact_quality_cap is present, recent_external_doc_like_pr_ratio >= 0.55, and top_starred_original_repo_quality_score < 0.3, explain the weak external-contribution quality in plain language without changing the score.",
			"no_sample_extrapolation":           "Do not infer that all merged PRs target one repo/type from recent_prs alone.",
			"impact_prs_outside_quality_sample": "Coverage note only: this count means some all-time popular-repo contributions lack file-level samples in this prompt. It is not a negative metric and must not be used alone for a score penalty.",
		}
		if needsHumanReview {
			notes["required_verdict"] = "needs human review: external PR quality is docs/site/examples/templates-heavy and the top-starred original repo has low project quality."
		}
		if strongCore {
			notes["strong_core_impact"] = "This is a substantive popular-repo contributor: high all-time popular-repo PR count, many verified core-impact PR samples, low external docs/style ratio, and low maintainer rejection. A templated/concentrated recent PR pattern may be flagged as review-needed, but the report must not describe the account as mostly test/doc/template work or as low-quality farming."
		}
		if m.ImpactQualityCap != nil {
			notes["impact_quality_cap"] = "Popular-repo ecosystem impact is weak because the inspectable samples are weakly verified or docs/site/examples/templates-heavy; explain that signal in user-facing language without changing the score."
		}
		return notes
	}
	notes = map[string]any{
		"recent_prs_scope":                  "recent_prs 只包含最近 merged PR 样本，不代表全量 PR 分布。",
		"account_time_scope":                "contribution_years_active 是账号创建后出现过贡献的自然年份数量，不是连续活跃时长；不要把它直接和 account_age_years 比较并写成穿越/来自未来。",
		"last_year_contributions_scope":     "last_year_contributions 是 GitHub 过去一年贡献日历的聚合计数，可能包含 commit、PR、Issue、Review 等多种计入活动；它不是 PR 数，也不提供仓库归属分布。不得把该数值全部归因于 PR、commit、外部仓库或用户自有仓库；贡献类型和仓库归属只能使用 payload 中对应的明确拆分字段。",
		"recent_prs_sample_size":            m.RecentMergedPRSample,
		"total_merged_pr_count":             m.MergedPRCount,
		"workflow_landed_pr_count":          valueOrZero(m.WorkflowLandedPRCount),
		"impact_repos_scope":                "impact_repos / metrics.impact_pr_count 汇总的是长期高星仓库实质 PR/commit 贡献；workflow_landed_impact_pr_count 是其中经仓库官方机器人验证、但不是 GitHub 原生 merged 的部分。",
		"workflow_landing_scope":            "不得把官方工作流已落地 PR 写成 GitHub 合并。它们只有在同一个官方机器人打上精确 Merged 标签、再关闭 PR 时才会被单独验证；可作为生态影响证据，但绝不能写成被拒。",
		"verified_impact_sample_scope":      "verified_impact_prs 只是文件级可验证样本，不能把样本条数写成长期贡献总数。",
		"doc_like_scope":                    "recent_doc_like_pr_ratio 覆盖所有最近 merged PR，可能包含作者自己的仓库；判断外部贡献质量时优先看 recent_external_doc_like_pr_ratio 以及高星影响 PR 的 core/doc-like 拆分。",
		"star_quality_scope":                "原创项目 star 分已按 top_starred_original_repo_quality_score 折扣；如果最高星仓库更像 profile/config/list/notebook 而不是可用项目，不要把这些 star 夸成项目实力。",
		"affiliation_scope":                 "学校、公司、雇主、组织 membership 只是背景信息，无论它们出现在 profile 字段还是 README 文本里；除非有真实仓库质量、PR/commit、release/tag、MAINTAINERS/CODEOWNERS 等维护证据支撑，否则不能作为夸奖或背书理由。",
		"attributed_original_scope":         "如果 metrics.attributed_original_repo_count > 0 或 top_repos 中存在 attributed_original=true，这些是基于长期维护强信号归属给用户的组织名下项目。在 roast/report 文案口径里，应把这些归属组织仓库视作用户的旗舰项目信号，而不是外部雇主/客户项目。应描述为“组织名下可归属/主导维护项目”，不要因为 repo owner 是组织就写成用户没有原创项目；也不要把这些已归属项目写成“别人的项目/借来的光环/给组织打工/给组织当长工/组织仆人/给他人盖宫殿/嫁衣”。可以吐槽单项目依赖，但不能否认归属。除非输入明确证明，不要声称其拥有 admin/owner/实际控制权。",
		"organization_maintained_scope":     "organization_maintained_repos 是展示用的公开组织维护证据：同时满足现有长期贡献阈值和仓库内维护证明。它不参与评分，也不证明用户拥有仓库、是管理员、受雇于组织或实际控制组织。可以点名完整 repo 与证据，但不得称为个人仓库，或据此改变分数。",
		"identity_scope":                    "不要因为给 Apache 等组织仓库提过 PR 就推断其是 Committer；只有输入明确给出身份时才能这样写。",
		"core_contribution_scope":           "如果 impact_quality_cap 存在，且 core_impact_pr_count 很少而 doc_like_impact_pr_count 更多，应描述为文档/站点/示例/模板/前端界面类贡献为主，不要写成核心工程贡献。",
		"low_quality_contribution_scope":    "如果 impact_quality_cap 存在、recent_external_doc_like_pr_ratio >= 0.55 且 top_starred_original_repo_quality_score < 0.3，就用人话解释外部贡献质量偏弱，但不得改分。",
		"no_sample_extrapolation":           "不要仅凭 recent_prs 推断所有 merged PR 都属于某个仓库或某类仓库。",
		"impact_prs_outside_quality_sample": "仅表示上下文覆盖范围：部分长期高星贡献没有文件级样本。这不是负面指标，不能单独作为扣分依据。",
	}
	if needsHumanReview {
		notes["required_verdict"] = "需人工复核：外部 PR 质量以文档/站点/示例/模板为主，且最高星原创仓库项目质量较低。"
	}
	if strongCore {
		notes["strong_core_impact"] = "这是实质高星贡献账号：长期高星仓库 PR 数高、可验证核心影响 PR 样本多、外部文档/样式占比低、维护者拒收率低。近期 PR 模式集中可以写成需要复核的风险，但报告不得写成主要是测试/文档/模板工作，也不得定性为低质量刷量。"
	}
	if m.ImpactQualityCap != nil {
		notes["impact_quality_cap"] = "生态影响偏弱的原因是高星贡献验证不足或文档/站点/示例/模板占比高；报告只需用人话解释这个信号，不得改分。"
	}
	return notes
}

// roastRiskNotes ports main's buildRiskNotes: five conditional display risks
// with concrete numbers, followed by scoring red-flag details.
func roastRiskNotes(scan ScanResult, language roastLanguage) []string {
	m, notes := scan.Metrics, []string{}
	externalDocRatio := m.RecentExternalDocLikePRRatio
	topQuality := m.TopStarredOriginalRepoQualityScore
	lowTrustImpact := m.ImpactQualityCap != nil && *m.ImpactQualityCap <= 4 && valueOrZero(m.CoreImpactPRCount) <= 2
	externalSample := m.RecentMergedPRSample
	if m.RecentExternalPRSample != nil {
		externalSample = *m.RecentExternalPRSample
	}
	docsHeavyExternal := externalSample >= 20 && externalDocRatio != nil && *externalDocRatio >= 0.55
	weakTopStarProject := topQuality != nil && *topQuality < 0.5 && m.TotalStars > 0
	selfClosedExternal := valueOrZero(m.SelfClosedExternalPRCount)
	totalExternalish := m.MergedPRCount + valueOrZero(m.MaintainerClosedUnmergedPRCount) + selfClosedExternal
	heavySelfClosedExternal := totalExternalish >= 20 && selfClosedExternal/totalExternalish >= 0.25
	weakCommunityConversion := m.Followers >= 500 && m.TotalStars > 0 &&
		m.TotalStars/max(m.Followers, 1) < 0.25 && (m.MaxStars < 150 || weakTopStarProject)

	if language == roastLanguageEN {
		if docsHeavyExternal {
			notes = append(notes, strconv.Itoa(pct(*externalDocRatio))+"% of recent external merged PRs are docs/site/examples/style work; this is visible contribution, but weak evidence of core engineering.")
		}
		if lowTrustImpact {
			notes = append(notes, "Popular-repo impact is capped at "+roastNumber(*m.ImpactQualityCap)+"/20: only "+roastNumber(valueOrZero(m.CoreImpactPRCount))+" core high-star PR sample(s) versus "+roastNumber(valueOrZero(m.DocLikeImpactPRCount))+" docs/site/example sample(s).")
		}
		if weakTopStarProject {
			repo := valueOrString(m.TopStarredOriginalRepoQualityRepo, "the top-starred original repo")
			notes = append(notes, repo+" is the top-starred original signal but looks more like profile/config/list/notebook material than a strong usable project.")
		}
		if weakCommunityConversion {
			notes = append(notes, roastNumber(m.Followers)+" followers but only "+roastNumber(m.TotalStars)+" total stars; the social signal is much stronger than the project signal.")
		}
		if heavySelfClosedExternal && (docsHeavyExternal || lowTrustImpact || weakTopStarProject) {
			notes = append(notes, roastNumber(selfClosedExternal)+" external PRs were closed by the author; not maintainer rejection, but combined with the quality signals it is a messy contribution-pattern warning.")
		}
	} else {
		if docsHeavyExternal {
			notes = append(notes, "最近外部合并 PR 里约 "+strconv.Itoa(pct(*externalDocRatio))+"% 是文档/站点/示例/样式类工作：有可见度，但不是核心工程硬实力。")
		}
		if lowTrustImpact {
			notes = append(notes, "高星仓库生态影响只有 "+roastNumber(*m.ImpactQualityCap)+"/20：可验证样本里核心改动 "+roastNumber(valueOrZero(m.CoreImpactPRCount))+" 个，文档/站点/示例类 "+roastNumber(valueOrZero(m.DocLikeImpactPRCount))+" 个。")
		}
		if weakTopStarProject {
			repo := valueOrString(m.TopStarredOriginalRepoQualityRepo, "最高星原创仓库")
			notes = append(notes, repo+" 是最高星原创信号，但更像 profile/config/list/notebook 这类展示材料，不像能独立站住的项目。")
		}
		if weakCommunityConversion {
			notes = append(notes, roastNumber(m.Followers)+" 个 followers 对 "+roastNumber(m.TotalStars)+" 总星，社交热度明显强过项目沉淀，粉丝滤镜偏重。")
		}
		if heavySelfClosedExternal && (docsHeavyExternal || lowTrustImpact || weakTopStarProject) {
			notes = append(notes, roastNumber(selfClosedExternal)+" 个外部 PR 由作者主动关闭；这不是维护者拒绝，但和低质量贡献信号叠在一起，说明贡献路径比较乱。")
		}
	}

	for _, flag := range scan.Scoring.RedFlags {
		if flag.Detail != "" {
			notes = append(notes, flag.Detail)
		}
	}
	return uniqueRoastStrings(notes, 6)
}

// roastFactualGuardrails ports main's buildFactualGuardrails, including the
// concrete numbers main embeds in each guardrail sentence.
func roastFactualGuardrails(scan ScanResult, language roastLanguage) []string {
	m, notes := scan.Metrics, []string{}
	if strongCoreImpact(scan) {
		if language == roastLanguageEN {
			notes = append(notes, "Strong-core fact: "+roastNumber(m.ImpactPRCount)+" popular-repo PRs and "+roastNumber(valueOrZero(m.CoreImpactPRCount))+" verified core-impact PR samples, with "+strconv.Itoa(pct(valueOrZero(m.RecentExternalDocLikePRRatio)))+"% recent external docs/style ratio and "+strconv.Itoa(pct(m.PRRejectionRate))+"% maintainer rejection. Do not call this mostly test/doc/template work, low-quality farming, or spam as fact.")
		} else {
			notes = append(notes, "强核心事实："+roastNumber(m.ImpactPRCount)+" 个高星仓库 PR、"+roastNumber(valueOrZero(m.CoreImpactPRCount))+" 个可验证核心影响 PR 样本，最近外部文档/样式占比 "+strconv.Itoa(pct(valueOrZero(m.RecentExternalDocLikePRRatio)))+"%、维护者拒收率 "+strconv.Itoa(pct(m.PRRejectionRate))+"%。不得写成主要是测试/文档/模板工作，不得定性为低质量刷量或刷子。")
		}
	}
	if valueOrZero(m.CoreImpactPRCount) > valueOrZero(m.DocLikeImpactPRCount) {
		if language == roastLanguageEN {
			notes = append(notes, "Core/doc-like split: verified core-impact samples ("+roastNumber(valueOrZero(m.CoreImpactPRCount))+") exceed docs/site/example samples ("+roastNumber(valueOrZero(m.DocLikeImpactPRCount))+"); do not claim the verified sample is all docs/tests/templates.")
		} else {
			notes = append(notes, "核心/文档样本拆分：可验证核心影响样本 "+roastNumber(valueOrZero(m.CoreImpactPRCount))+" 个，多于文档/站点/示例样本 "+roastNumber(valueOrZero(m.DocLikeImpactPRCount))+" 个；不得声称可验证样本全是文档/测试/模板。")
		}
	}
	if m.PRFloodSuspect {
		if language == roastLanguageEN {
			notes = append(notes, "Templated/concentrated PR titles are a pattern risk only. They require diff review and must not be converted into an AI-use, spam, or low-quality conclusion without corroborating quality evidence.")
		} else {
			notes = append(notes, "PR 标题模板化/集中只是模式风险，需要看 diff 复核；没有叠加低质量证据时，不得外推成 AI 使用、刷量、垃圾贡献或低质量结论。")
		}
	}
	if m.ImpactPRCount > 0 && valueOrZero(m.ImpactCommitCount) == 0 {
		if language == roastLanguageEN {
			notes = append(notes, "Zero popular-repo commits means the detected popular-repo impact is PR-based. Do not infer missing commit access, lack of trust, or lack of contribution from that.")
		} else {
			notes = append(notes, "高星仓库 commit 为 0 只表示检测到的高星影响来自 PR；不得推断没有提交权限、不被信任或没有真实贡献。")
		}
	}
	return notes
}

// signatureClusterNote ports main's signatureClusterNote: source note plus the
// low-star / org-ecosystem / recent-sample caution fragments, joined by spaces.
func signatureClusterNote(cluster SignatureWorkCluster, source string, language roastLanguage) string {
	parts := []string{}
	if language == roastLanguageEN {
		if source == "all_history_public_scan" {
			parts = append(parts, "All-history repeated work cluster from the durable public scan.")
		} else {
			parts = append(parts, "Recent repeated work cluster from a bounded sample; use it as evidence without treating it as the whole history.")
		}
	} else {
		if source == "all_history_public_scan" {
			parts = append(parts, "来自持久化全量公开扫描的重复工作簇。")
		} else {
			parts = append(parts, "来自有限近期样本的重复工作簇；可以作为证据，但不能外推成全部历史。")
		}
	}
	if cluster.SubstantiveLowStarSignal {
		if language == roastLanguageEN {
			parts = append(parts, "Low stars are not enough to dismiss this repo: repeated PRs plus security/boundary/consistency/runtime/core-behavior titles make it a substantive work signal.")
		} else {
			parts = append(parts, "不能因为 star 低就当低价值：重复 PR 加上安全、边界、一致性、运行时或核心行为标题，说明它是实质工作信号。")
		}
	}
	if cluster.OrgContextRepo != nil {
		stars := roastNumber(valueOrZero(cluster.OrgContextStars))
		if language == roastLanguageEN {
			parts = append(parts, "Same owner ecosystem as "+*cluster.OrgContextRepo+" ("+stars+" stars); do not write it off as a toy sibling just because this repo has fewer stars.")
		} else {
			parts = append(parts, "同属 "+*cluster.OrgContextRepo+"（"+stars+" stars）所在 owner 生态；不要因为这个仓库 star 少就写成玩具项目或打白工。")
		}
	}
	if source == "recent_sample" && !cluster.SubstantiveLowStarSignal {
		if language == roastLanguageEN {
			parts = append(parts, "Because this is only a recent sample, repeated docs/site/example/CSS titles are maintenance evidence, not proof of core fixes.")
		} else {
			parts = append(parts, "因为这只是近期样本，重复的 docs/site/example/CSS 标题只能当维护或样例工作看，不能写成核心实质修复。")
		}
	}
	return strings.Join(parts, " ")
}

// roastSignatureWork ports main's buildSignatureWork. The Go collector always
// stores a signature_work snapshot, so the recent_prs-derived fallback below
// only fires for zero-value structs (e.g. hand-crafted replay payloads),
// matching main's `scan.signature_work` truthiness branch.
func roastSignatureWork(scan ScanResult, language roastLanguage) map[string]any {
	source := scan.SignatureWork.Source
	if source == "" {
		source = "recent_sample"
	}
	// TS uses `??`, so a present-but-empty representatives list stays empty;
	// only an absent list falls back to deriving one from impact_repos.
	rawRepresentatives := scan.SignatureWork.ImpactRepoRepresentatives
	if rawRepresentatives == nil {
		rawRepresentatives = signatureImpactRepos(scan.ImpactRepos)
	}
	representatives := make([]map[string]any, 0, len(rawRepresentatives))
	for _, repo := range rawRepresentatives {
		note := roastNumber(repo.PRs) + " 个 PR + " + roastNumber(repo.Commits) + " 个 commit；长期代表性贡献目标，不只是按 star 摆门面。"
		if language == roastLanguageEN {
			note = roastNumber(repo.PRs) + " PR(s) + " + roastNumber(repo.Commits) + " commit(s); representative all-time contribution target, not just a star-flex entry."
		}
		representatives = append(representatives, map[string]any{
			"repo": repo.Repo, "stars": repo.Stars, "prs": repo.PRs, "commits": repo.Commits, "note": note,
		})
	}

	if scan.SignatureWork.Source != "" {
		orgEcosystem := []map[string]any{}
		for _, cluster := range scan.SignatureWork.WorkClusters {
			if cluster.OrgContextRepo == nil {
				continue
			}
			prs := valueOrZero(cluster.RecentMergedPRsInSample)
			if cluster.AllTimePRs != nil {
				prs = *cluster.AllTimePRs
			}
			note := "同 owner 生态贡献：解释生态/维护影响力时，要把 " + cluster.Repo + " 和 " + *cluster.OrgContextRepo + " 放在一起写，不能只写高星 flagship。"
			if language == roastLanguageEN {
				note = "Same-owner ecosystem work: mention " + cluster.Repo + " alongside " + *cluster.OrgContextRepo + " in the Ecosystem / maintenance row when explaining impact."
			}
			entry := map[string]any{
				"repo": cluster.Repo, "stars": cluster.Stars, "prs": prs,
				"org_context_repo": *cluster.OrgContextRepo,
				"examples":         append([]string(nil), cluster.Examples[:minInt(len(cluster.Examples), 3)]...),
				"note":             note,
			}
			if cluster.OrgContextStars != nil {
				entry["org_context_stars"] = *cluster.OrgContextStars
			}
			orgEcosystem = append(orgEcosystem, entry)
		}
		workClusters := make([]map[string]any, 0, len(scan.SignatureWork.WorkClusters))
		for _, cluster := range scan.SignatureWork.WorkClusters {
			item := roastJSONMap(cluster)
			item["note"] = signatureClusterNote(cluster, source, language)
			workClusters = append(workClusters, item)
		}
		var instruction string
		switch {
		case language == roastLanguageEN && source == "all_history_public_scan":
			instruction = "Use these all-history signature examples as named evidence of concrete work. Do not ignore high-volume or core-fix clusters just because another repo has more stars. If any work cluster has org_context_repo or substantive_low_star_signal=true, name at least one such repo in the Ecosystem / maintenance row."
		case language == roastLanguageEN:
			instruction = "Use these sample-derived signature examples carefully. Do not ignore them, but do not extrapolate one recent cluster into the whole history. Repeated docs/site/example/CSS work is maintenance evidence, not proof of core fixes. If any work cluster has org_context_repo or substantive_low_star_signal=true, name at least one such repo in the Ecosystem / maintenance row."
		case source == "all_history_public_scan":
			instruction = "这些是全量历史 signature 例子，必须作为具体贡献证据参考。不要只因另一个仓库 star 更高就忽略高频或核心修复类工作簇。若任一工作簇存在 org_context_repo 或 substantive_low_star_signal=true，生态/维护影响力行必须至少点名一个这类仓库。"
		default:
			instruction = "这些是样本推导出的 signature 例子，需要参考，但不得把单个近期工作簇外推成全部历史。重复的 docs/site/example/CSS 工作只能写成维护或样例贡献，不能写成核心实质修复。若任一工作簇存在 org_context_repo 或 substantive_low_star_signal=true，生态/维护影响力行必须至少点名一个这类仓库。"
		}
		return map[string]any{
			"source":                      source,
			"impact_repo_representatives": representatives,
			"org_ecosystem_repositories":  orgEcosystem,
			"work_clusters":               workClusters,
			"instruction":                 instruction,
		}
	}

	// Fallback branch (main: scan.signature_work undefined). Unlike the
	// collector's BuildRecentSignatureWork this does not attach org context,
	// matching main's prompt-side reconstruction.
	type recentClusterDraft struct {
		cluster SignatureWorkCluster
		count   float64
	}
	drafts := map[string]*recentClusterDraft{}
	order := []string{}
	for _, pr := range scan.RecentPRs {
		if pr.Repo == nil || *pr.Repo == "" {
			continue
		}
		draft := drafts[*pr.Repo]
		if draft == nil {
			draft = &recentClusterDraft{cluster: SignatureWorkCluster{Repo: *pr.Repo, Examples: []string{}}}
			drafts[*pr.Repo] = draft
			order = append(order, *pr.Repo)
		}
		draft.count++
		draft.cluster.Stars = max(draft.cluster.Stars, pr.RepoStars)
		if pr.Title == nil || strings.TrimSpace(*pr.Title) == "" {
			continue
		}
		title := strings.TrimSpace(*pr.Title)
		if isSignatureQualityTitle(title) {
			draft.cluster.QualityKeywordHits++
			addClusterExample(&draft.cluster, title, true)
		} else {
			addClusterExample(&draft.cluster, title, false)
		}
	}
	clusters := []SignatureWorkCluster{}
	for _, key := range order {
		draft := drafts[key]
		if draft.count >= 3 || draft.cluster.QualityKeywordHits >= 2 {
			draft.cluster.RecentMergedPRsInSample = floatPointer(draft.count)
			clusters = append(clusters, draft.cluster)
		}
	}
	sort.SliceStable(clusters, func(i, j int) bool {
		return clusterScore(clusters[i]) > clusterScore(clusters[j]) || (clusterScore(clusters[i]) == clusterScore(clusters[j]) && clusters[i].Stars > clusters[j].Stars)
	})
	if len(clusters) > 5 {
		clusters = clusters[:5]
	}
	workClusters := make([]map[string]any, 0, len(clusters))
	for _, cluster := range clusters {
		note := "近期重复工作簇。可以当维护证据写；如果标题是 docs/site/example/CSS 类，不能称为核心实质修复，除非 payload 还有其他核心行为证据。"
		if language == roastLanguageEN {
			note = "Recent repeated work cluster. Mention it as maintenance evidence; do not call docs/site/example/CSS titles core fixes unless other payload evidence proves core behavior work."
		}
		workClusters = append(workClusters, map[string]any{
			"repo":                        cluster.Repo,
			"stars":                       cluster.Stars,
			"recent_merged_prs_in_sample": valueOrZero(cluster.RecentMergedPRsInSample),
			"quality_keyword_hits":        cluster.QualityKeywordHits,
			"examples":                    cluster.Examples,
			"note":                        note,
		})
	}
	instruction := "这些是样本推导出的 signature 例子，需要参考，但不得把单个近期工作簇外推成全部历史。重复的 docs/site/example/CSS 工作只能写成维护或样例贡献，不能写成核心实质修复。"
	if language == roastLanguageEN {
		instruction = "Use these sample-derived signature examples carefully. Do not ignore them, but do not extrapolate one recent cluster into the whole history. Repeated docs/site/example/CSS work is maintenance evidence, not proof of core fixes."
	}
	return map[string]any{
		"source":                      source,
		"impact_repo_representatives": representatives,
		"work_clusters":               workClusters,
		"instruction":                 instruction,
	}
}

// roastOrganizationMaintainedRepos exposes the presentation-only maintenance
// evidence in a compact, explicit shape. Keeping it separate from top_repos
// makes it mechanically clear to the writer that this is not score evidence.
func roastOrganizationMaintainedRepos(scan ScanResult) []map[string]any {
	result := make([]map[string]any, 0, len(scan.SignatureWork.OrganizationMaintainedRepos))
	for _, work := range scan.SignatureWork.OrganizationMaintainedRepos {
		repository := roastJSONMap(work.Repository)
		delete(repository, "open_issues")
		result = append(result, map[string]any{
			"repo":         repoDisplayName(work.Repository),
			"repository":   repository,
			"commits":      work.Commits,
			"prs":          work.PRs,
			"active_years": work.ActiveYears,
			"evidence":     append([]string(nil), work.Evidence...),
		})
	}
	return result
}

func englishTierName(tier string) string {
	switch tier {
	case "夯":
		return "GOD"
	case "顶级":
		return "ELITE"
	case "人上人":
		return "SOLID"
	case "NPC":
		return "NPC"
	default:
		return "TRASH"
	}
}

func uniqueRoastStrings(values []string, limit int) []string {
	seen, result := map[string]bool{}, []string{}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
		if len(result) >= limit {
			break
		}
	}
	return result
}

// boundedRoastScan mirrors main route.ts sanitizeScan: it bounds every
// client-supplied collection, including the signature_work slices main caps at
// 12 representatives / 16 clusters / 5 examples of 200 chars.
func boundedRoastScan(scan ScanResult) ScanResult {
	scan.TopRepos = append([]TopRepo(nil), scan.TopRepos[:minInt(len(scan.TopRepos), 10)]...)
	for index := range scan.TopRepos {
		scan.TopRepos[index].Description = truncateString(scan.TopRepos[index].Description, 300)
		scan.TopRepos[index].ReadmeExcerpt = truncateString(scan.TopRepos[index].ReadmeExcerpt, 1500)
		if scan.TopRepos[index].Readme != nil {
			scan.TopRepos[index].Readme.Features.PromptSummary = truncateRunes(scan.TopRepos[index].Readme.Features.PromptSummary, 1500)
		}
	}
	scan.RecentPRs = append([]RecentPR(nil), scan.RecentPRs[:minInt(len(scan.RecentPRs), 50)]...)
	for index := range scan.RecentPRs {
		scan.RecentPRs[index].Title = truncateString(scan.RecentPRs[index].Title, 200)
		scan.RecentPRs[index].Files = truncateStrings(scan.RecentPRs[index].Files, 20, 200)
	}
	scan.FloodPRTitles = truncateStrings(scan.FloodPRTitles, 5, 200)
	scan.ImpactRepos = append([]ImpactRepo(nil), scan.ImpactRepos[:minInt(len(scan.ImpactRepos), 8)]...)
	scan.VerifiedImpactPRs = append([]RecentPR(nil), scan.VerifiedImpactPRs[:minInt(len(scan.VerifiedImpactPRs), 12)]...)
	for index := range scan.VerifiedImpactPRs {
		scan.VerifiedImpactPRs[index].Title = truncateString(scan.VerifiedImpactPRs[index].Title, 200)
		scan.VerifiedImpactPRs[index].Files = truncateStrings(scan.VerifiedImpactPRs[index].Files, 20, 200)
	}
	scan.SignatureWork.ImpactRepoRepresentatives = append([]ImpactRepo(nil), scan.SignatureWork.ImpactRepoRepresentatives[:minInt(len(scan.SignatureWork.ImpactRepoRepresentatives), 12)]...)
	scan.SignatureWork.WorkClusters = append([]SignatureWorkCluster(nil), scan.SignatureWork.WorkClusters[:minInt(len(scan.SignatureWork.WorkClusters), 16)]...)
	for index := range scan.SignatureWork.WorkClusters {
		scan.SignatureWork.WorkClusters[index].Examples = truncateStrings(scan.SignatureWork.WorkClusters[index].Examples, 5, 200)
	}
	scan.SignatureWork.OrganizationMaintainedRepos = append([]OrganizationMaintainedRepo(nil), scan.SignatureWork.OrganizationMaintainedRepos[:minInt(len(scan.SignatureWork.OrganizationMaintainedRepos), maxOrganizationMaintainedRepos)]...)
	for index := range scan.SignatureWork.OrganizationMaintainedRepos {
		repository := &scan.SignatureWork.OrganizationMaintainedRepos[index].Repository
		repository.Description = truncateString(repository.Description, 300)
		repository.ReadmeExcerpt = truncateString(repository.ReadmeExcerpt, 1500)
		if repository.Readme != nil {
			repository.Readme.Features.PromptSummary = truncateRunes(repository.Readme.Features.PromptSummary, 1500)
		}
		scan.SignatureWork.OrganizationMaintainedRepos[index].Evidence = truncateStrings(scan.SignatureWork.OrganizationMaintainedRepos[index].Evidence, 3, 200)
	}
	return scan
}

func truncateString(value *string, limit int) *string {
	if value == nil {
		return nil
	}
	trimmed := truncateRunes(*value, limit)
	return &trimmed
}

func truncateStrings(values []string, count, length int) []string {
	values = append([]string(nil), values[:minInt(len(values), count)]...)
	for index := range values {
		values[index] = truncateRunes(values[index], length)
	}
	return values
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func normalizeRoastText(value string) string { return strings.Join(strings.Fields(value), " ") }
