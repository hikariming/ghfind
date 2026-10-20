package backend

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

var presentationUI = regexp.MustCompile(`(?i)(^|[-_./])(ui|design|design-system|components?|widgets?|styles?|css|themes?|antd|mui|chakra|shadcn|patternfly|tailwind(css)?)([-_./]|$)`)
var presentationSite = regexp.MustCompile(`(?i)(^|[-_./])(site|website|blog|docs?|homepage)([-_./]|$)|site$|\.github\.io$`)
var presentationCore = regexp.MustCompile(`\.(c|cc|cpp|cs|go|java|kt|m|mm|php|py|rb|rs|scala|swift)$`)
var presentationServer = regexp.MustCompile(`(^|/)(server|backend|api|database|db|auth)(/|$)`)
var presentationJS = regexp.MustCompile(`\.(jsx?|tsx?)$`)
var presentationDocusaurus = regexp.MustCompile(`(^|/)docusaurus\.config\.[cm]?[jt]s$`)
var presentationCoreFile = regexp.MustCompile(`(?i)\.(c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte|css|scss|sass|less|styl)$`)
var presentationStyle = regexp.MustCompile(`\.(css|scss|sass|less|styl)$`)
var presentationPaths = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(^|/)(assets?|public|static)/.*(?:\.[a-z0-9_-]{6,}\.m?js|\.min\.js)$`),
	regexp.MustCompile(`\.(md|mdx|rst|adoc|txt|svg|png|jpe?g|gif|webp|css|scss|sass|less|styl)$`),
	regexp.MustCompile(`(^|/)(docs?|site|website|blog|content|articles|examples?|templates?|tutorials?|guides?|manual|i18n|locales?|__snapshots__|demos?|storybook|screenshots?)(/|$)`),
	regexp.MustCompile(`(^|/)(readme|changelog|contributing|license)(\.[^/]*)?$`),
	regexp.MustCompile(`(^|/)(pages/home|components/home[^/]*)(/|$)`),
}
var presentationSiteFiles = regexp.MustCompile(`\.(jsx?|tsx?|vue|svelte|astro|html)$|(^|/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.json)$`)

func isPresentationPath(path, repo string, docSite bool) bool {
	p := strings.ToLower(path)
	if presentationCore.MatchString(p) {
		return false
	}
	if presentationServer.MatchString(p) && presentationJS.MatchString(p) {
		return false
	}
	if presentationUI.MatchString(repo) && presentationStyle.MatchString(p) {
		return false
	}
	for _, re := range presentationPaths {
		if re.MatchString(p) {
			return true
		}
	}
	parts := strings.Split(repo, "/")
	return (presentationSite.MatchString(parts[len(parts)-1]) || docSite) && !presentationUI.MatchString(repo) && presentationSiteFiles.MatchString(p)
}

func applyPresentationSignals(m *RawMetrics, prs []RecentPR, login string, ownRepos []string) {
	owned := map[string]bool{}
	for _, repo := range ownRepos {
		owned[strings.ToLower(repo)] = true
	}
	churn, presentation, coreChurn, n, core := 0.0, 0.0, 0.0, 0.0, 0.0
	byRepo := map[string]float64{}
	for _, pr := range prs {
		repo := ""
		if pr.Repo != nil {
			repo = strings.ToLower(*pr.Repo)
		}
		if !strings.Contains(repo, "/") || strings.Split(repo, "/")[0] == strings.ToLower(login) {
			continue
		}
		external := 1.0
		if owned[repo] {
			share, ok := m.AttributedOriginalRepoShares[repo]
			if !ok {
				share = 1
			}
			external = 1 - coUnit(share)
		}
		if external <= 0 {
			continue
		}
		if len(pr.FileChanges) == 0 || float64(len(pr.FileChanges)) < pr.ChangedFiles {
			continue
		}
		docSite := false
		for _, f := range pr.FileChanges {
			if presentationDocusaurus.MatchString(f.Path) {
				docSite = true
			}
		}
		total, amount := 0.0, 0.0
		for _, f := range pr.FileChanges {
			c := max(0, f.Additions) + max(0, f.Deletions)
			total += c
			if isPresentationPath(f.Path, repo, docSite) {
				amount += c
			} else if presentationCoreFile.MatchString(f.Path) {
				coreChurn += external * c
			}
		}
		if total <= 0 {
			continue
		}
		churn += external * total
		presentation += external * amount
		n += external
		if total > 5 && amount/total <= .4 && pr.RepoStars >= 200 {
			core += external
		}
		byRepo[repo] += external * amount
	}
	p, c := 0.0, 0.0
	if churn > 0 {
		p = presentation / churn
	}
	shares := []float64{}
	for _, amount := range byRepo {
		shares = append(shares, amount)
	}
	sort.Sort(sort.Reverse(sort.Float64Slice(shares)))
	if presentation > 0 {
		for i := 0; i < len(shares) && i < 2; i++ {
			c += shares[i] / presentation
		}
	}
	coreShare := 0.0
	if churn > 0 {
		coreShare = coreChurn / churn
	}
	m.PresentationCoreChurnShare = &coreShare
	m.PresentationChurnShare = &p
	m.PresentationRepoConcentration = &c
	m.PresentationPRSample = &n
	m.PresentationCorePRCount = &core
}
func presentationDiscount(m RawMetrics) float64 {
	x := max(0, min(1, (valueOrZero(m.PresentationChurnShare)-.4)/.4))
	n := max(0, valueOrZero(m.PresentationPRSample))
	c := max(0, min(1, valueOrZero(m.PresentationRepoConcentration)))
	core := max(0, valueOrZero(m.PresentationCorePRCount), valueOrZero(m.CoreImpactPRCount))
	coreShare := max(0, min(1, (valueOrZero(m.PresentationCoreChurnShare)-.2)/.2))
	churnProtection := 1 - coreShare*coreShare*(3-2*coreShare)
	protection := churnProtection / (1 + math.Pow(max(0, core-3)/5, 2))
	return 1 - .7*x*x*(3-2*x)*(.5+.5*c)*n/(n+2)*protection
}
func externalPRShare(m RawMetrics) float64 {
	return min(1, max(0, valueOrZero(m.ExternalMergedPRCount))/max(1, m.MergedPRCount))
}
func ecosystemPresentationDiscount(m RawMetrics) float64 {
	return 1 - (1-presentationDiscount(m))*externalPRShare(m)
}

func prPresentationShare(pr RecentPR) (float64, bool) {
	if len(pr.FileChanges) == 0 || float64(len(pr.FileChanges)) < pr.ChangedFiles {
		return 0, false
	}
	docSite := false
	for _, f := range pr.FileChanges {
		if presentationDocusaurus.MatchString(f.Path) {
			docSite = true
		}
	}
	total, amount := 0.0, 0.0
	repo := ""
	if pr.Repo != nil {
		repo = *pr.Repo
	}
	for _, f := range pr.FileChanges {
		c := max(0, f.Additions) + max(0, f.Deletions)
		total += c
		if isPresentationPath(f.Path, repo, docSite) {
			amount += c
		}
	}
	if total <= 0 {
		return 0, false
	}
	return amount / total, true
}
