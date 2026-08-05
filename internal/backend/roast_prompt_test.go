package backend

import (
	"encoding/json"
	"strings"
	"testing"
)

// These tests port the assertions of main's src/lib/__tests__/prompt.test.ts
// so the Go roast prompt stays behaviorally identical with main.

func roastPromptBaseScan() ScanResult {
	return ScanResult{
		Metrics: RawMetrics{
			Username:                "sample-user",
			MergedPRCount:           74,
			RecentMergedPRSample:    50,
			ImpactPRCount:           10,
			ImpactCommitCount:       floatPointer(5),
			ImpactRepoCount:         floatPointer(4),
			UnverifiedImpactPRCount: floatPointer(7),
		},
		TopRepos:      []TopRepo{},
		RecentPRs:     []RecentPR{},
		FloodPRTitles: []string{},
		ImpactRepos:   []ImpactRepo{},
		VerifiedImpactPRs: []RecentPR{{
			Title:        stringPointer("refactor: use current_user in console controllers"),
			Repo:         stringPointer("popular-ai/backend"),
			RepoStars:    146000,
			Churn:        207,
			ChangedFiles: 14,
			Files:        []string{"api/controllers/console/wraps.py", "api/tests/unit_tests/controllers/console/test_wraps.py"},
		}},
		Scoring: Scoring{SubScores: SubScores{}, RedFlags: []RedFlag{}, FinalScore: 95.2, Tier: "夯", TierLabel: "封神 · 殿堂级标杆"},
	}
}

func roastPromptUserPayload(t *testing.T, messages []LLMMessage) map[string]any {
	t.Helper()
	if len(messages) != 2 || messages[0].Role != "system" || messages[1].Role != "user" {
		t.Fatalf("messages=%#v", messages)
	}
	content := messages[1].Content
	start := strings.Index(content, "```json\n")
	if start < 0 || !strings.HasSuffix(content, "\n```") {
		t.Fatalf("user message missing json fence: %q", content)
	}
	payload := map[string]any{}
	if err := json.Unmarshal([]byte(content[start+len("```json\n"):len(content)-len("\n```")]), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return payload
}

func roastPayloadMap(t *testing.T, payload map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := payload[key].(map[string]any)
	if !ok {
		t.Fatalf("payload[%q]=%#v", key, payload[key])
	}
	return value
}

func roastPayloadStrings(t *testing.T, payload map[string]any, key string) []string {
	t.Helper()
	items, ok := payload[key].([]any)
	if !ok {
		t.Fatalf("payload[%q]=%#v", key, payload[key])
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("payload[%q] contains %#v", key, item)
		}
		result = append(result, text)
	}
	return result
}

func roastPayloadSlice(t *testing.T, payload map[string]any, key string) []any {
	t.Helper()
	items, ok := payload[key].([]any)
	if !ok {
		t.Fatalf("payload[%q]=%#v", key, payload[key])
	}
	return items
}

func requireAnyContaining(t *testing.T, values []string, needles ...string) {
	t.Helper()
	for _, needle := range needles {
		found := false
		for _, value := range values {
			if strings.Contains(value, needle) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("no value contains %q: %#v", needle, values)
		}
	}
}

func TestRoastSystemPromptsCarryMainReportTemplate(t *testing.T) {
	// Key lines copied verbatim from main's SYSTEM_PROMPT_ZH (src/lib/prompt.ts),
	// including the six-dimension table template.
	for _, needle := range []string{
		"   第一行必须严格写 `@@ADJUST 0@@`。",
		"| 维度 | 得分 | 说明 |\n|------|------|------|",
		"| 账号成熟度 | x/10 | 注册 N 年，贡献跨 M 个自然年 |",
		"| 原创项目质量 | x/18 | 总 star …, 最高 star … |",
		"| 贡献质量 | x/27 | 合并 PR …, 总 PR …；维护者关闭未合并 …，作者主动关闭外部 PR …，作者主动关闭自有仓库 PR … |",
		"| 生态/维护影响力 | x/20 | 向 ★… 仓库长期贡献 N 个 PR + M 个 commit(综合长期贡献，见 impact_summary/impact_repos；可验证样本只用于举例，不是总量) |",
		"| 社区影响力 | x/8 | followers … |",
		"| 活跃真实性 | x/17 | 近一年贡献 … |",
		"②标题最终分直接使用 scoring.final_score，保留两位小数；③表格各维度得分直接用 sub_scores",
	} {
		if !strings.Contains(roastSystemZH, needle) {
			t.Fatalf("ZH system prompt missing main line %q", needle)
		}
	}
	// Same for main's SYSTEM_PROMPT_EN.
	for _, needle := range []string{
		"   Line 1 must be exactly `@@ADJUST 0@@`.",
		"| Dimension | Score | Notes |\n|-----------|-------|-------|",
		"| Account maturity | x/10 | registered N yrs, contributions span M calendar years |",
		"| Contribution quality | x/27 | merged PRs …, total PRs …; maintainer-closed unmerged …, author-closed external PRs …, author-closed own-repo PRs … |",
		"| Ecosystem / maintenance impact | x/20 | N PRs + M commits into ★… repos (all-time, see impact_summary/impact_repos; verified samples are examples only, not the total) |",
		"② the title's final score must use scoring.final_score, to two decimals",
	} {
		if !strings.Contains(roastSystemEN, needle) {
			t.Fatalf("EN system prompt missing main line %q", needle)
		}
	}
	// "~" is the backtick stand-in inside the Go raw-string templates; a leak
	// means the init-time replacement regressed.
	if strings.Contains(roastSystemZH, "~") || strings.Contains(roastSystemEN, "~") {
		t.Fatal("backtick placeholder leaked into the final system prompt")
	}
}

func TestRoastPromptControlLinesAndNoInlineRoastMarker(t *testing.T) {
	scan := roastPromptBaseScan()
	for _, language := range []roastLanguage{roastLanguageZH, roastLanguageEN} {
		system := buildRoastPrompt(scan, language)[0].Content
		for _, needle := range []string{"@@ADJUST 0@@", "@@TAGS", "@@ROAST", "zh=", "en="} {
			if !strings.Contains(system, needle) {
				t.Fatalf("%s system prompt missing %q", language, needle)
			}
		}
		if strings.Contains(system, "🔥") {
			t.Fatalf("%s system prompt must not ask for an inline roast marker", language)
		}
	}
}

func TestRoastPromptKeepsMainGuardrailCopy(t *testing.T) {
	scan := roastPromptBaseScan()
	zh := buildRoastPrompt(scan, roastLanguageZH)[0].Content
	for _, needle := range []string{
		"GitHub 毒舌锐评写手",
		"分数、档位、六维分和质量风险都已由确定性评分引擎给出",
		"分数来自评分引擎，不是你的判断",
		"学校、公司、雇主、组织 membership 只是背景",
		"不得重算、四舍五入到别的分、升降档",
		"不能改分、不能暗示模型另有裁决",
		"标题最终分直接使用 scoring.final_score",
		"展示层脱敏",
		"被评分引擎压到/封顶/裁定",
		"owner/small-repo 与 owner/flagship",
		"扎心度要求",
		"先落事实，再补一刀",
		"NPC / 拉完了强制火力",
		"GitHub 当谈资简历",
		"页面顶部卡片的主毒舌",
		"英文 ≤140 chars",
		"低 star 仓库不是自动低价值",
		"生态/维护影响力行必须先用 impact_summary 的长期总量",
		"报告尾部必须分块输出",
	} {
		if !strings.Contains(zh, needle) {
			t.Fatalf("ZH system prompt missing %q", needle)
		}
	}
	en := buildRoastPrompt(scan, roastLanguageEN)[0].Content
	for _, needle := range []string{
		"savage GitHub report writer",
		"The score comes from the scoring engine",
		"background context, not score evidence",
		"Do not recompute, round into another score, move tiers",
		"Presentation hygiene and roast strength",
		"Never expose internal field names",
		"scoring engine capped/decided",
		"Make It Sting",
		"fact first, jab second",
		"NPC / TRASH Mandatory Heat",
		"GitHub resume theater",
		"top-card main roast",
		"English ≤140 chars",
		"impact_summary's all-time totals",
		"separated blocks with blank lines",
	} {
		if !strings.Contains(en, needle) {
			t.Fatalf("EN system prompt missing %q", needle)
		}
	}
}

func TestRoastPromptAsksForPRStatusBreakdown(t *testing.T) {
	scan := roastPromptBaseScan()
	zh := buildRoastPrompt(scan, roastLanguageZH)[0].Content
	if strings.Contains(zh, "通过率") {
		t.Fatal("ZH system prompt must not ask for an acceptance rate")
	}
	for _, needle := range []string{"维护者关闭未合并", "官方工作流已落地 PR", "作者主动关闭外部 PR", "作者主动关闭自有仓库 PR"} {
		if !strings.Contains(zh, needle) {
			t.Fatalf("ZH system prompt missing %q", needle)
		}
	}
	en := buildRoastPrompt(scan, roastLanguageEN)[0].Content
	if strings.Contains(en, "acceptance rate") {
		t.Fatal("EN system prompt must not ask for an acceptance rate")
	}
	for _, needle := range []string{"maintainer-closed unmerged", "workflow-landed PRs", "author-closed external PRs", "author-closed own-repo PRs"} {
		if !strings.Contains(en, needle) {
			t.Fatalf("EN system prompt missing %q", needle)
		}
	}
}

func TestRoastPromptEnglishPayloadOverridesTier(t *testing.T) {
	messages := buildRoastPrompt(roastPromptBaseScan(), roastLanguageEN)
	user := messages[1].Content
	if !strings.Contains(user, "scoring data") || !strings.Contains(user, "sample-user") {
		t.Fatalf("user message missing preamble or username: %q", user)
	}
	if !strings.Contains(user, `"tier": "GOD"`) || !strings.Contains(user, `"tier_label": "Legendary · Hall of Fame"`) {
		t.Fatalf("EN payload must override tier naming: %q", user)
	}
	if strings.Contains(user, "封神") {
		t.Fatalf("EN payload leaked the Chinese tier label: %q", user)
	}
}

func TestRoastPromptExposesOnlyVerifiedIssueCounts(t *testing.T) {
	scan := roastPromptBaseScan()
	scan.TopRepos = []TopRepo{{
		Name: "example-repo", OwnerLogin: stringPointer("example-owner"),
		NameWithOwner: stringPointer("example-owner/example-repo"),
		// GitHub REST's aggregate can be five open PRs and zero Issues.
		OpenIssues: 5, OpenIssueCount: floatPointer(0),
	}}
	for _, language := range []roastLanguage{roastLanguageZH, roastLanguageEN} {
		messages := buildRoastPrompt(scan, language)
		payload := roastPromptUserPayload(t, messages)
		repo := roastPayloadSlice(t, payload, "top_repos")[0].(map[string]any)
		if _, leaked := repo["open_issues"]; leaked {
			t.Fatalf("%s payload leaked the REST open_issues aggregate", language)
		}
		if repo["open_issue_count"] != float64(0) {
			t.Fatalf("%s open_issue_count=%#v", language, repo["open_issue_count"])
		}
		system := messages[0].Content
		if !strings.Contains(system, "open_issue_count") {
			t.Fatalf("%s system prompt must mention open_issue_count", language)
		}
		if !strings.Contains(system, "open pull requests") && !strings.Contains(system, "开放 PR") {
			t.Fatalf("%s system prompt must separate open PRs from Issues", language)
		}
	}
}

func TestRoastPromptDoesNotDuplicateStructuredReadmeSummary(t *testing.T) {
	scan := roastPromptBaseScan()
	scan.TopRepos = []TopRepo{
		{Name: "project", ReadmeExcerpt: stringPointer("Structured summary"), Readme: &RepoReadme{Features: ReadmeFeatures{PromptSummary: "Structured summary"}}},
		{Name: "legacy", ReadmeExcerpt: stringPointer("Legacy summary")},
	}
	payload := roastPromptUserPayload(t, buildRoastPrompt(scan, roastLanguageZH))
	repos := roastPayloadSlice(t, payload, "top_repos")
	first, second := repos[0].(map[string]any), repos[1].(map[string]any)
	if _, duplicated := first["readme_excerpt"]; duplicated {
		t.Fatal("readme_excerpt must be dropped when prompt_summary carries the summary")
	}
	readme := first["readme"].(map[string]any)
	if readme["features"].(map[string]any)["prompt_summary"] != "Structured summary" {
		t.Fatalf("prompt_summary lost: %#v", readme)
	}
	if second["readme_excerpt"] != "Legacy summary" {
		t.Fatalf("legacy excerpt=%#v", second["readme_excerpt"])
	}
}

func TestRoastPromptKeepsImpactCoverageNeutral(t *testing.T) {
	payload := roastPromptUserPayload(t, buildRoastPrompt(roastPromptBaseScan(), roastLanguageZH))
	metrics := roastPayloadMap(t, payload, "metrics")
	if _, leaked := metrics["unverified_impact_pr_count"]; leaked {
		t.Fatal("unverified_impact_pr_count must be renamed out of the payload")
	}
	if metrics["impact_prs_outside_quality_sample"] != float64(7) {
		t.Fatalf("impact_prs_outside_quality_sample=%#v", metrics["impact_prs_outside_quality_sample"])
	}
	context := roastPayloadMap(t, payload, "context_notes")
	if !strings.Contains(context["impact_prs_outside_quality_sample"].(string), "不是负面指标") {
		t.Fatalf("coverage note=%q", context["impact_prs_outside_quality_sample"])
	}
	if !strings.Contains(context["verified_impact_sample_scope"].(string), "不能把样本条数写成长期贡献总数") {
		t.Fatalf("verified sample scope=%q", context["verified_impact_sample_scope"])
	}
	summary := roastPayloadMap(t, payload, "impact_summary")
	for key, want := range map[string]float64{"popular_repo_pr_count": 10, "popular_repo_commit_count": 5, "popular_repo_count": 4, "verified_file_sample_count": 1} {
		if summary[key] != want {
			t.Fatalf("impact_summary[%q]=%#v want %v", key, summary[key], want)
		}
	}
	if !strings.Contains(summary["sample_rule"].(string), "不是总贡献数") {
		t.Fatalf("sample_rule=%q", summary["sample_rule"])
	}
	verified := roastPayloadSlice(t, payload, "verified_impact_prs")[0].(map[string]any)
	if verified["repo"] != "popular-ai/backend" || verified["repo_stars"] != float64(146000) || verified["changed_files"] != float64(14) {
		t.Fatalf("verified sample=%#v", verified)
	}
	if !strings.Contains(roastPayloadMap(t, roastPromptUserPayload(t, buildRoastPrompt(roastPromptBaseScan(), roastLanguageEN)), "impact_summary")["total_rule"].(string), "popular_repo_pr_count + popular_repo_commit_count") {
		t.Fatal("EN total_rule must reference the all-time totals")
	}
}

func TestRoastPromptMarksRecentPRsAsSample(t *testing.T) {
	zhPayload := roastPromptUserPayload(t, buildRoastPrompt(roastPromptBaseScan(), roastLanguageZH))
	context := roastPayloadMap(t, zhPayload, "context_notes")
	if context["recent_prs_sample_size"] != float64(50) || context["total_merged_pr_count"] != float64(74) {
		t.Fatalf("sample context=%#v", context)
	}
	for key, needle := range map[string]string{
		"recent_prs_scope":          "不代表全量 PR 分布",
		"account_time_scope":        "自然年份数量",
		"no_sample_extrapolation":   "不要仅凭 recent_prs",
		"workflow_landing_scope":    "不得把官方工作流已落地 PR 写成 GitHub 合并",
		"affiliation_scope":         "不能作为夸奖或背书理由",
		"attributed_original_scope": "组织名下可归属/主导维护项目",
	} {
		if !strings.Contains(context[key].(string), needle) {
			t.Fatalf("context_notes[%q]=%q missing %q", key, context[key], needle)
		}
	}
	if !strings.Contains(context["account_time_scope"].(string), "不要把它直接和 account_age_years 比较") {
		t.Fatalf("account_time_scope=%q", context["account_time_scope"])
	}
	enPayload := roastPromptUserPayload(t, buildRoastPrompt(roastPromptBaseScan(), roastLanguageEN))
	enContext := roastPayloadMap(t, enPayload, "context_notes")
	for key, needle := range map[string]string{
		"recent_prs_scope":        "not the all-time PR distribution",
		"account_time_scope":      "calendar years with contributions",
		"no_sample_extrapolation": "Do not infer",
		"workflow_landing_scope":  "Never call workflow-landed PRs GitHub merges",
		"affiliation_scope":       "must not justify praise",
	} {
		if !strings.Contains(enContext[key].(string), needle) {
			t.Fatalf("en context_notes[%q]=%q missing %q", key, enContext[key], needle)
		}
	}
	if !strings.Contains(enContext["account_time_scope"].(string), "time-travel") {
		t.Fatalf("en account_time_scope=%q", enContext["account_time_scope"])
	}
	if !strings.Contains(enContext["affiliation_scope"].(string), "README text") {
		t.Fatalf("en affiliation_scope=%q", enContext["affiliation_scope"])
	}
}

func TestRoastPromptWorkflowLandedCountSurfaces(t *testing.T) {
	scan := roastPromptBaseScan()
	scan.Metrics.WorkflowLandedPRCount = floatPointer(3)
	scan.Metrics.WorkflowLandedImpactPRCount = floatPointer(3)
	for _, language := range []roastLanguage{roastLanguageZH, roastLanguageEN} {
		context := roastPayloadMap(t, roastPromptUserPayload(t, buildRoastPrompt(scan, language)), "context_notes")
		if context["workflow_landed_pr_count"] != float64(3) {
			t.Fatalf("%s workflow_landed_pr_count=%#v", language, context["workflow_landed_pr_count"])
		}
	}
}

func TestRoastPromptLowTrustRequiresHumanReview(t *testing.T) {
	scan := roastPromptBaseScan()
	scan.Metrics.TotalStars = 157
	scan.Metrics.ImpactQualityCap = floatPointer(4)
	scan.Metrics.RecentExternalDocLikePRRatio = floatPointer(0.59)
	scan.Metrics.TopStarredOriginalRepoQualityScore = floatPointer(0.14)

	zhPayload := roastPromptUserPayload(t, buildRoastPrompt(scan, roastLanguageZH))
	if !strings.Contains(roastPayloadMap(t, zhPayload, "context_notes")["required_verdict"].(string), "需人工复核") {
		t.Fatal("ZH required_verdict missing")
	}
	requireAnyContaining(t, roastPayloadStrings(t, zhPayload, "risk_notes"),
		"文档/站点/示例/样式类工作", "高星仓库生态影响", "最高星原创")

	enPayload := roastPromptUserPayload(t, buildRoastPrompt(scan, roastLanguageEN))
	if !strings.Contains(roastPayloadMap(t, enPayload, "context_notes")["required_verdict"].(string), "needs human review") {
		t.Fatal("EN required_verdict missing")
	}
	requireAnyContaining(t, roastPayloadStrings(t, enPayload, "risk_notes"),
		"docs/site/examples/style work", "Popular-repo impact", "top-starred original signal")
}

func TestRoastPromptBuildsDisplayRisksForDocsHeavySocialProfile(t *testing.T) {
	scan := roastPromptBaseScan()
	scan.Metrics.Followers = 1040
	scan.Metrics.TotalStars = 157
	scan.Metrics.MaxStars = 83
	scan.Metrics.MergedPRCount = 38
	scan.Metrics.MaintainerClosedUnmergedPRCount = floatPointer(8)
	scan.Metrics.RecentMergedPRSample = 38
	scan.Metrics.RecentExternalPRSample = floatPointer(37)
	scan.Metrics.RecentExternalDocLikePRRatio = floatPointer(0.62)
	scan.Metrics.ImpactQualityCap = floatPointer(4)
	scan.Metrics.CoreImpactPRCount = floatPointer(1)
	scan.Metrics.DocLikeImpactPRCount = floatPointer(4)
	scan.Metrics.TopStarredOriginalRepoQualityScore = floatPointer(0.39)
	scan.Metrics.TopStarredOriginalRepoQualityRepo = stringPointer("docs-heavy/profile")
	scan.Metrics.SelfClosedExternalPRCount = floatPointer(22)
	scan.Scoring.RedFlags = []RedFlag{}

	payload := roastPromptUserPayload(t, buildRoastPrompt(scan, roastLanguageZH))
	if flags := roastPayloadSlice(t, roastPayloadMap(t, payload, "scoring"), "red_flags"); len(flags) != 0 {
		t.Fatalf("red_flags=%#v", flags)
	}
	requireAnyContaining(t, roastPayloadStrings(t, payload, "risk_notes"),
		"约 62%", "高星仓库生态影响", "docs-heavy/profile", "followers", "22 个外部 PR 由作者主动关闭")
}

func TestRoastPromptDoesNotFlagSmallAuthorClosedVolume(t *testing.T) {
	scan := roastPromptBaseScan()
	scan.Metrics.MergedPRCount = 109
	scan.Metrics.MaintainerClosedUnmergedPRCount = floatPointer(0)
	scan.Metrics.SelfClosedExternalPRCount = floatPointer(13)
	scan.Metrics.RecentMergedPRSample = 50
	scan.Metrics.RecentExternalPRSample = floatPointer(50)
	scan.Metrics.RecentExternalDocLikePRRatio = floatPointer(0.08)
	scan.Metrics.CoreImpactPRCount = floatPointer(5)
	scan.Metrics.DocLikeImpactPRCount = floatPointer(0)
	scan.Metrics.TopStarredOriginalRepoQualityScore = floatPointer(0.8)
	scan.Scoring.RedFlags = []RedFlag{}

	payload := roastPromptUserPayload(t, buildRoastPrompt(scan, roastLanguageZH))
	if notes := roastPayloadStrings(t, payload, "risk_notes"); len(notes) != 0 {
		t.Fatalf("risk_notes=%#v", notes)
	}
}

func TestRoastPromptMarksHighCoreTemplatedContributorsAsSubstantive(t *testing.T) {
	scan := roastPromptBaseScan()
	scan.Metrics.MergedPRCount = 1000
	scan.Metrics.ImpactPRCount = 600
	scan.Metrics.ImpactCommitCount = floatPointer(0)
	scan.Metrics.RecentMergedPRSample = 30
	scan.Metrics.RecentExternalDocLikePRRatio = floatPointer(0)
	scan.Metrics.CoreImpactPRCount = floatPointer(50)
	scan.Metrics.DocLikeImpactPRCount = floatPointer(0)
	scan.Metrics.PRRejectionRate = 0.08
	scan.Metrics.PRFloodSuspect = true
	scan.Metrics.TopRepoPRTarget = stringPointer("foundation/workflow")
	scan.Metrics.TopRepoPRShare = 0.6
	scan.Metrics.TemplatedPRRatio = 0.6
	scan.Scoring.RedFlags = []RedFlag{{
		Flag:    "templated_pr_flooding",
		Penalty: 5,
		Detail:  "近期 60% 的 PR 集中刷向 foundation/workflow，60% 标题高度模板化（30 个样本） — 模式化批量贡献风险，需结合 diff 质量人工复核。",
	}}

	zhPayload := roastPromptUserPayload(t, buildRoastPrompt(scan, roastLanguageZH))
	zhContext := roastPayloadMap(t, zhPayload, "context_notes")
	if !strings.Contains(zhContext["strong_core_impact"].(string), "实质高星贡献账号") ||
		!strings.Contains(zhContext["strong_core_impact"].(string), "不得定性为低质量刷量") {
		t.Fatalf("strong_core_impact=%q", zhContext["strong_core_impact"])
	}
	requireAnyContaining(t, roastPayloadStrings(t, zhPayload, "factual_guardrails"),
		"强核心事实", "不得写成主要是测试/文档/模板工作", "不得外推成 AI 使用", "不得推断没有提交权限")

	enPayload := roastPromptUserPayload(t, buildRoastPrompt(scan, roastLanguageEN))
	enContext := roastPayloadMap(t, enPayload, "context_notes")
	if !strings.Contains(enContext["strong_core_impact"].(string), "substantive popular-repo contributor") ||
		!strings.Contains(enContext["strong_core_impact"].(string), "low-quality farming") {
		t.Fatalf("en strong_core_impact=%q", enContext["strong_core_impact"])
	}
	requireAnyContaining(t, roastPayloadStrings(t, enPayload, "factual_guardrails"),
		"Strong-core fact", "mostly test/doc/template work", "AI-use", "missing commit access")
}

func TestRoastPromptSurfacesRecentSignatureWorkClusters(t *testing.T) {
	scan := roastPromptBaseScan()
	// Zero-value SignatureWork (no stored snapshot) triggers main's
	// recent_prs-derived fallback branch.
	scan.SignatureWork = SignatureWork{}
	scan.ImpactRepos = []ImpactRepo{
		{Repo: "mega/popular", Stars: 100000, PRs: 1, Commits: 0},
		{Repo: "rust/tooling", Stars: 15000, PRs: 9, Commits: 0},
	}
	title := func(value string) *string { return &value }
	scan.RecentPRs = []RecentPR{
		{Title: title("fix(api): revoke bound deployment capabilities"), Repo: stringPointer("org/control-plane"), RepoStars: 40, Churn: 200, ChangedFiles: 5},
		{Title: title("fix(cost): atomically persist usage ledger"), Repo: stringPointer("org/control-plane"), RepoStars: 40, Churn: 140, ChangedFiles: 4},
		{Title: title("feat(api): persist bound capability run provenance"), Repo: stringPointer("org/control-plane"), RepoStars: 40, Churn: 180, ChangedFiles: 6},
	}

	payload := roastPromptUserPayload(t, buildRoastPrompt(scan, roastLanguageZH))
	signature := roastPayloadMap(t, payload, "signature_work")
	instruction := signature["instruction"].(string)
	if !strings.Contains(instruction, "样本推导") || !strings.Contains(instruction, "不得") {
		t.Fatalf("instruction=%q", instruction)
	}
	representatives := roastPayloadSlice(t, signature, "impact_repo_representatives")
	foundRepresentative := false
	for _, item := range representatives {
		repo := item.(map[string]any)
		if repo["repo"] == "rust/tooling" && repo["prs"] == float64(9) {
			foundRepresentative = true
		}
	}
	if !foundRepresentative {
		t.Fatalf("representatives=%#v", representatives)
	}
	clusters := roastPayloadSlice(t, signature, "work_clusters")
	if len(clusters) != 1 {
		t.Fatalf("work_clusters=%#v", clusters)
	}
	cluster := clusters[0].(map[string]any)
	if cluster["repo"] != "org/control-plane" || cluster["recent_merged_prs_in_sample"] != float64(3) || cluster["quality_keyword_hits"] != float64(3) {
		t.Fatalf("cluster=%#v", cluster)
	}
}

func TestRoastPromptExplainsAllHistoryLowStarSignatureWork(t *testing.T) {
	scan := roastPromptBaseScan()
	scan.SignatureWork = SignatureWork{
		Source: "all_history_public_scan",
		ImpactRepoRepresentatives: []ImpactRepo{
			{Repo: "org/main-platform", Stars: 100000, PRs: 1, Commits: 0},
		},
		WorkClusters: []SignatureWorkCluster{{
			Repo:                     "org/control-plane",
			Stars:                    39,
			AllTimePRs:               floatPointer(3),
			QualityKeywordHits:       3,
			Examples:                 []string{"fix(api): revoke bound deployment capabilities", "fix(cost): atomically persist usage ledger", "feat(api): persist bound capability run provenance"},
			OrgContextRepo:           stringPointer("org/main-platform"),
			OrgContextStars:          floatPointer(100000),
			SubstantiveLowStarSignal: true,
		}},
	}

	messages := buildRoastPrompt(scan, roastLanguageZH)
	if !strings.Contains(messages[0].Content, "低 star 仓库不是自动低价值") {
		t.Fatal("ZH system prompt must cover low-star signature work")
	}
	payload := roastPromptUserPayload(t, messages)
	signature := roastPayloadMap(t, payload, "signature_work")
	instruction := signature["instruction"].(string)
	for _, needle := range []string{"全量历史", "至少点名一个", "生态/维护影响力行"} {
		if !strings.Contains(instruction, needle) {
			t.Fatalf("instruction=%q missing %q", instruction, needle)
		}
	}
	ecosystem := roastPayloadSlice(t, signature, "org_ecosystem_repositories")
	if len(ecosystem) != 1 {
		t.Fatalf("org_ecosystem_repositories=%#v", ecosystem)
	}
	entry := ecosystem[0].(map[string]any)
	if entry["repo"] != "org/control-plane" || entry["org_context_repo"] != "org/main-platform" || entry["prs"] != float64(3) {
		t.Fatalf("ecosystem entry=%#v", entry)
	}
	note := roastPayloadSlice(t, signature, "work_clusters")[0].(map[string]any)["note"].(string)
	for _, needle := range []string{"不能因为 star 低就当低价值", "org/main-platform", "不要因为这个仓库 star 少"} {
		if !strings.Contains(note, needle) {
			t.Fatalf("cluster note=%q missing %q", note, needle)
		}
	}
}

func TestRoastPromptScoreContractExcludesJudgeArtifacts(t *testing.T) {
	for _, language := range []roastLanguage{roastLanguageZH, roastLanguageEN} {
		messages := buildRoastPrompt(roastPromptBaseScan(), language)
		payload := roastPromptUserPayload(t, messages)
		if !strings.Contains(payload["score_contract"].(string), "@@ADJUST 0@@") {
			t.Fatalf("%s score_contract=%q", language, payload["score_contract"])
		}
		for _, forbidden := range []string{"judge_result", "calibration_contract"} {
			if _, present := payload[forbidden]; present {
				t.Fatalf("%s payload must not contain %q", language, forbidden)
			}
		}
		if strings.Contains(messages[1].Content, `"judge_result"`) {
			t.Fatalf("%s user payload leaked judge_result", language)
		}
	}
}
