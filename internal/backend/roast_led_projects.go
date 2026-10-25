package backend

import (
	"math"
	"strconv"
	"strings"
)

// ledProjectMinShare mirrors LED_PROJECT_MIN_SHARE in src/lib/prompt.ts.
const ledProjectMinShare = 0.15

// roastLedProjects mirrors ledProjects: attributed repos the user substantially
// leads or maintains.
func roastLedProjects(scan ScanResult) []TopRepo {
	out := []TopRepo{}
	for _, repo := range scan.TopRepos {
		if repo.AttributedOriginal && repo.AttributionShare != nil && *repo.AttributionShare >= ledProjectMinShare {
			out = append(out, repo)
			if len(out) == 3 {
				break
			}
		}
	}
	return out
}

func ledProjectName(repo TopRepo) string {
	if repo.NameWithOwner != nil && *repo.NameWithOwner != "" {
		return *repo.NameWithOwner
	}
	return valueOrString(repo.OwnerLogin, "") + "/" + repo.Name
}

func isRoastLedProject(scan ScanResult, name *string) bool {
	if name == nil || *name == "" {
		return false
	}
	for _, repo := range roastLedProjects(scan) {
		if strings.EqualFold(ledProjectName(repo), *name) {
			return true
		}
	}
	return false
}

// displayStars mirrors displayStars: user-facing star counts are whole numbers.
func displayStars(value float64) float64 { return math.Round(max(0, value)) }

func ledProjectGuardrail(repo TopRepo, language roastLanguage) string {
	name, stars := ledProjectName(repo), roastNumber(displayStars(repo.Stars))
	f := repo.CoCreatorFacts
	if f == nil {
		if language == roastLanguageEN {
			return name + " (" + stars + " stars) is a project this user leads or co-maintains. Describe the real work they do on it; never call it profile/config/showcase material, a backdrop, or someone else's asset."
		}
		return name + "（" + stars + " 星）是该用户主导/共同维护的项目。按 TA 在其中的实际工作来写；不得称为 profile/config/展示材料、背景板或“别人的资产”。"
	}
	top := f.UserCommits >= f.LeadingCommits && f.UserCommits > 0
	rankRatio := strconv.Itoa(pct(f.UserCommits / max(1, f.LeadingCommits)))
	recentShare := 0.0
	if f.RecentTotalCommits != nil && *f.RecentTotalCommits > 0 {
		recentShare = valueOrZero(f.RecentUserCommits) / *f.RecentTotalCommits
	}
	current := recentShare >= 0.35
	commits := roastNumber(f.UserCommits) + "/" + roastNumber(f.TotalCommits)
	prs := roastNumber(f.UserMergedPRs) + "/" + roastNumber(f.TotalMergedPRs)
	if language == roastLanguageEN {
		rank := rankRatio + "% of the top committer's commits"
		if top {
			rank = "the top committer"
		}
		recent := ""
		if f.RecentTotalCommits != nil {
			recent = "; last 180 days: " + roastNumber(valueOrZero(f.RecentUserCommits)) + "/" + roastNumber(*f.RecentTotalCommits) + " commits"
			if f.RecentTotalMergedPRs != nil {
				recent += ", " + roastNumber(valueOrZero(f.RecentUserMergedPRs)) + "/" + roastNumber(*f.RecentTotalMergedPRs) + " merged PRs"
			}
		}
		role := "leads or co-maintains"
		if current {
			role = "actively maintains and runs as a primary current maintainer"
		}
		return name + " (" + stars + " stars) is a project this user " + role + ": " + commits + " commits (" + rank + "), " + prs + " merged PRs" + recent + ". Describe it as their real maintenance/engineering work. Never call it profile/config/showcase material, a backdrop, or someone else's asset, and do not use the credited share to belittle them (\"only xx%\")."
	}
	rank := "提交数约为第一名的 " + rankRatio + "%"
	if top {
		rank = "提交数第一"
	}
	recent := ""
	if f.RecentTotalCommits != nil {
		recent = "；近 180 天提交 " + roastNumber(valueOrZero(f.RecentUserCommits)) + "/" + roastNumber(*f.RecentTotalCommits)
		if f.RecentTotalMergedPRs != nil {
			recent += "、合并 PR " + roastNumber(valueOrZero(f.RecentUserMergedPRs)) + "/" + roastNumber(*f.RecentTotalMergedPRs)
		}
	}
	role := "主导/共同维护"
	if current {
		role = "当前主要维护和运营"
	}
	return name + "（" + stars + " 星）是该用户" + role + "的项目：提交 " + commits + "（" + rank + "）、合并 PR " + prs + recent + "。应写成 TA 实际维护/开发这个项目的贡献；不得称为 profile/config/展示材料、背景板或“别人的资产”，也不得用计入份额贬低（如“只占 xx%”）。"
}
