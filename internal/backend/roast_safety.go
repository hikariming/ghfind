package backend

import (
	"regexp"
	"strconv"
	"strings"
)

// The public report must never turn collection metadata into a claim about a
// person. These post-generation guards are deliberately applied to tags, the
// share-line and every streamed report fragment; prompts reduce mistakes, but
// they are not a safety boundary.
var (
	roastInternalPhrases = []struct{ pattern, replacement string }{
		{`(?i)commit\s*数为\s*0[^。；\n]*(?:权限|permission)[^。；\n]*`, "commit 数为 0，只说明检测到的高星影响来自 PR"},
		{`(?:评分引擎|scoring engine)[^，。；,.\n]*(?:封顶|压到|裁定|capped|decided)[^，。；,.\n]*`, "这项表现偏弱"},
		{`(?i)score cap`, "weak evidence"},
		{`按规则扣分`, "数据上吃亏"},
		{`(?i)rules deducted`, "the data hurts here"},
	}
	roastIdentityTitle = regexp.MustCompile(`(?i)\b(committer|maintainer|core\s+team(?:\s+member)?|core\s+maintainer|project\s+member|team\s+member)\b`)
	roastIdentityZH    = regexp.MustCompile(`(?:核心成员|核心维护者|维护者|项目成员|团队成员)`)
)

func strongCoreImpact(scan ScanResult) bool {
	m := scan.Metrics
	return valueOrZero(m.CoreImpactPRCount) >= 10 && m.ImpactPRCount >= 50 &&
		valueOr(valueOrPtr(m.RecentExternalDocLikePRRatio, m.RecentDocLikePRRatio), 0) < 0.25 &&
		m.PRRejectionRate < 0.2
}

func valueOrPtr(primary, fallback *float64) *float64 {
	if primary != nil {
		return primary
	}
	return fallback
}

func profileMentionsIdentity(metrics RawMetrics, title string) bool {
	profile := strings.ToLower(strings.Join(nonEmptyStrings(valueOrString(metrics.Name, ""), valueOrString(metrics.Bio, ""), valueOrString(metrics.Company, "")), " "))
	return strings.Contains(profile, strings.ToLower(title))
}

func nonEmptyStrings(values ...string) []string {
	result := []string{}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return result
}

func sanitizeIdentityClaims(scan ScanResult, text string) string {
	if text == "" {
		return text
	}
	text = regexp.MustCompile(`(?i)\b(?:fake|pseudo)\s+([A-Z][A-Za-z0-9_.-]*)\s+(?:committer|maintainer|core\s+team(?:\s+member)?)\b`).ReplaceAllString(text, "$1 repo visitor")
	text = regexp.MustCompile(`(?i)\b([A-Z][A-Za-z0-9_.-]*)\s+(committer|maintainer|core\s+team(?:\s+member)?|core\s+maintainer)\b`).ReplaceAllStringFunc(text, func(match string) string {
		if profileMentionsIdentity(scan.Metrics, match) {
			return match
		}
		parts := strings.Fields(match)
		if len(parts) == 0 {
			return "related repo contributor"
		}
		return parts[0] + " related repo contributor"
	})
	text = roastIdentityTitle.ReplaceAllStringFunc(text, func(match string) string {
		if profileMentionsIdentity(scan.Metrics, match) {
			return match
		}
		return "contributor"
	})
	if !profileMentionsIdentity(scan.Metrics, "维护者") {
		text = roastIdentityZH.ReplaceAllString(text, "相关仓库贡献者")
	}
	return text
}

func sanitizeStrongCoreText(scan ScanResult, text string) string {
	if !strongCoreImpact(scan) || text == "" {
		return text
	}
	return strings.NewReplacer(
		"PR刷子", "模式PR工", "PR Spammer", "Pattern PR", "PR Farmer", "Pattern PR",
		"模板化刷", "模板化提交", "刷测试PR", "批量提交同类测试PR", "刷测试用例", "批量提交测试用例",
		"刷KPI", "做同类迁移", "KPI", "同类改动", "刷量", "模式化贡献", "刷", "提交",
		"蹭外部项目", "依赖外部项目", "蹭大厂", "依赖大项目", "蹭大项目", "依赖大项目", "蹭", "依赖",
		"含水量", "争议点", "水分", "争议点", "低质量贡献", "需复核贡献", "垃圾贡献", "需复核贡献",
		"没有提交权限", "没有直接 commit 信号", "没有 commit 权限", "没有直接 commit 信号",
		"不被信任", "没有直接 commit 信号", "AI代笔", "AI辅助", "AI生成", "AI辅助",
		"作弊", "有原创性争议", "丢人", "有原创性争议", "懒", "有原创性争议",
	).Replace(text)
}

func sanitizeInternalRoastText(text string) string {
	for _, rule := range roastInternalPhrases {
		text = regexp.MustCompile(rule.pattern).ReplaceAllString(text, rule.replacement)
	}
	return internalTerms.ReplaceAllString(text, "public evidence")
}

func roastEvidenceRepos(scan ScanResult) []string {
	seen, result := map[string]bool{}, []string{}
	for _, repo := range append(append([]ImpactRepo{}, scan.ImpactRepos...), scan.SignatureWork.ImpactRepoRepresentatives...) {
		if strings.Count(repo.Repo, "/") != 1 || seen[strings.ToLower(repo.Repo)] {
			continue
		}
		seen[strings.ToLower(repo.Repo)] = true
		result = append(result, repo.Repo)
	}
	for _, cluster := range scan.SignatureWork.WorkClusters {
		if strings.Count(cluster.Repo, "/") != 1 || seen[strings.ToLower(cluster.Repo)] {
			continue
		}
		seen[strings.ToLower(cluster.Repo)] = true
		result = append(result, cluster.Repo)
	}
	return result
}

// A model often shortens an evidence repository after mentioning a star count.
// Expand only aliases that are unique in the supplied evidence, so a generic
// word is never rewritten into a fabricated repository name.
func sanitizeRepoShorthand(scan ScanResult, text string) string {
	for _, full := range roastEvidenceRepos(scan) {
		_, alias, ok := strings.Cut(full, "/")
		if !ok || len(alias) < 3 {
			continue
		}
		unique := true
		for _, other := range roastEvidenceRepos(scan) {
			_, otherAlias, _ := strings.Cut(other, "/")
			if !strings.EqualFold(full, other) && strings.EqualFold(alias, otherAlias) {
				unique = false
				break
			}
		}
		if !unique {
			continue
		}
		// Keep this narrow: replacing every bare alias would corrupt ordinary
		// prose. These prefixes cover the forms the old renderer corrected.
		for _, prefix := range []string{"stars ", "star ", "星 ", "向", "to "} {
			needle := prefix + alias
			if strings.Contains(strings.ToLower(text), strings.ToLower(needle)) {
				text = replaceFold(text, needle, prefix+full)
			}
		}
	}
	return text
}

func replaceFold(text, needle, replacement string) string {
	lower, target := strings.ToLower(text), strings.ToLower(needle)
	start := 0
	for {
		index := strings.Index(lower[start:], target)
		if index < 0 {
			return text
		}
		index += start
		text = text[:index] + replacement + text[index+len(needle):]
		lower = strings.ToLower(text)
		start = index + len(replacement)
	}
}

func sanitizeRoastText(scan ScanResult, text string) string {
	return sanitizeStrongCoreText(scan, sanitizeRepoShorthand(scan, sanitizeInternalRoastText(sanitizeIdentityClaims(scan, text))))
}

func sanitizeRoastArtifacts(scan ScanResult, tags Tags, line RoastLine, report string) (Tags, RoastLine, string) {
	tags = ensureRoastTags(tags)
	for index := range tags.ZH {
		tags.ZH[index] = sanitizeRoastText(scan, tags.ZH[index])
	}
	for index := range tags.EN {
		tags.EN[index] = sanitizeRoastText(scan, tags.EN[index])
	}
	line.ZH = clampGeneratedRoastLine(sanitizeRoastText(scan, line.ZH), false)
	line.EN = clampGeneratedRoastLine(sanitizeRoastText(scan, line.EN), true)
	return tags, line, sanitizeRoastText(scan, report)
}

func signatureWorkAppendix(scan ScanResult, language roastLanguage, report string) string {
	clusters := scan.SignatureWork.WorkClusters
	if len(clusters) == 0 {
		return ""
	}
	candidates := []SignatureWorkCluster{clusters[0]}
	for _, cluster := range clusters {
		if cluster.OrgContextRepo != nil && !strings.EqualFold(cluster.Repo, candidates[0].Repo) {
			candidates = append(candidates, cluster)
			break
		}
	}
	lines := []string{}
	for _, cluster := range candidates {
		if strings.Contains(strings.ToLower(report), strings.ToLower(cluster.Repo)) {
			continue
		}
		count := valueOrZero(cluster.RecentMergedPRsInSample)
		examples := strings.Join(cluster.Examples[:minInt(len(cluster.Examples), 2)], "; ")
		if language == roastLanguageEN {
			line := "- Additional auditable activity includes " + cluster.Repo + ": " + roastNumber(count) + " PRs in the available sample"
			if examples != "" {
				line += ", e.g. \"" + examples + "\""
			}
			lines = append(lines, line+".")
		} else {
			line := "- 补充可核对的活动：" + cluster.Repo + " 在可用样本中有 " + roastNumber(count) + " 个 PR"
			if examples != "" {
				line += "，例如「" + examples + "」"
			}
			lines = append(lines, line+"。")
		}
	}
	if len(lines) == 0 {
		return ""
	}
	if language == roastLanguageEN {
		return "\n\n**Additional evidence**\n" + strings.Join(lines, "\n")
	}
	return "\n\n**补充证据**\n" + strings.Join(lines, "\n")
}

func roastNumber(value float64) string { return strconv.FormatFloat(value, 'f', -1, 64) }

func splitRoastPending(value string, keep int, force bool) (string, string) {
	if force {
		return value, ""
	}
	runes := []rune(value)
	if len(runes) <= keep {
		return "", value
	}
	return string(runes[:len(runes)-keep]), string(runes[len(runes)-keep:])
}
