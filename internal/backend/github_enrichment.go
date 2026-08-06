package backend

import (
	"context"
	"encoding/base64"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const readmeFetchLimit = 1024 * 1024
const readmePromptSummaryLimit = 1500

type githubReadme struct {
	Path        string  `json:"path"`
	SHA         *string `json:"sha"`
	Size        float64 `json:"size"`
	HTMLURL     *string `json:"html_url"`
	DownloadURL *string `json:"download_url"`
	Content     string  `json:"content"`
	Encoding    string  `json:"encoding"`
}

func (c *GitHubClient) fetchReadmeDocument(ctx context.Context, owner, repo string) (*RepoReadme, error) {
	var document githubReadme
	if err := c.restGet(ctx, "repos/"+owner+"/"+repo+"/readme", &document); err != nil {
		if err == ErrGitHubAccountNotFound {
			return nil, nil
		}
		return nil, err
	}
	if document.Content == "" || !strings.EqualFold(document.Encoding, "base64") || document.Size > readmeFetchLimit {
		return nil, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(document.Content), ""))
	if err != nil {
		return nil, nil
	}
	features := ParseReadmeFeatures(string(decoded))
	return &RepoReadme{Path: valueOrString(&document.Path, "README"), SHA: document.SHA, Size: document.Size, HTMLURL: document.HTMLURL, Truncated: document.Size > readmeFetchLimit, Features: features}, nil
}

func (c *GitHubClient) fetchRepoLanguages(ctx context.Context, owner, repo string) ([]RepoLanguage, error) {
	var raw map[string]float64
	if err := c.restGet(ctx, "repos/"+owner+"/"+repo+"/languages", &raw); err != nil {
		if err == ErrGitHubAccountNotFound {
			return []RepoLanguage{}, nil
		}
		return nil, err
	}
	languages := make([]RepoLanguage, 0, len(raw))
	for name, size := range raw {
		languages = append(languages, RepoLanguage{Name: name, Size: size})
	}
	sort.Slice(languages, func(i, j int) bool { return languages[i].Size > languages[j].Size })
	return languages, nil
}

func (c *GitHubClient) fetchRepoEngagementRatio(ctx context.Context, owner, name string) *float64 {
	var result struct {
		Repository *struct {
			StargazerCount   float64 `json:"stargazerCount"`
			HasIssuesEnabled bool    `json:"hasIssuesEnabled"`
			IsMirror         bool    `json:"isMirror"`
			Watchers         *struct {
				TotalCount float64 `json:"totalCount"`
			} `json:"watchers"`
			Issues *struct {
				TotalCount float64 `json:"totalCount"`
			} `json:"issues"`
			PullRequests *struct {
				TotalCount float64 `json:"totalCount"`
			} `json:"pullRequests"`
		} `json:"repository"`
	}
	query := `query($owner: String!, $name: String!) {
 repository(owner: $owner, name: $name) {
  stargazerCount hasIssuesEnabled isMirror watchers { totalCount } issues { totalCount } pullRequests { totalCount }
 }
}`
	if c.graphql(ctx, query, map[string]any{"owner": owner, "name": name}, &result) != nil || result.Repository == nil || result.Repository.StargazerCount == 0 || result.Repository.IsMirror || !result.Repository.HasIssuesEnabled {
		return nil
	}
	ratio := roundJS((valueOrZeroStruct(result.Repository.Watchers)+valueOrZeroStruct(result.Repository.Issues)+valueOrZeroStruct(result.Repository.PullRequests))/result.Repository.StargazerCount*10000) / 10000
	return &ratio
}

func valueOrZeroStruct(value *struct {
	TotalCount float64 `json:"totalCount"`
}) float64 {
	if value == nil {
		return 0
	}
	return value.TotalCount
}

var readmeCommentRE = regexp.MustCompile(`<!--[\s\S]*?-->`)
var readmeHeadingRE = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*#*\s*$`)
var readmeImageRE = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)
var readmeLinkRE = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`)

type readmeSection struct {
	Title string
	Text  string
}

func cleanReadmeLine(line string) string {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "[![") || strings.HasPrefix(trimmed, "![") {
		return ""
	}
	trimmed = readmeImageRE.ReplaceAllString(trimmed, "$1")
	trimmed = readmeLinkRE.ReplaceAllString(trimmed, "$1")
	trimmed = strings.NewReplacer("`", " ", "*", " ", "_", " ", ">", " ", "|", " ", "#", " ").Replace(trimmed)
	return strings.Join(strings.Fields(trimmed), " ")
}

func textMatches(text string, words []string) bool {
	for _, word := range words {
		if regexp.MustCompile(`(?i)\b` + word + `\b`).MatchString(text) {
			return true
		}
	}
	return false
}

func clampText(text string, limit int) string {
	clean := strings.Join(strings.Fields(text), " ")
	if len(clean) <= limit {
		return clean
	}
	return clean[:limit-1] + "…"
}

// ParseReadmeFeatures is the Go port of the evidence parser used by the
// Node collector. Its fields feed repository quality and the roast prompt.
func ParseReadmeFeatures(markdown string) ReadmeFeatures {
	markdown = strings.ReplaceAll(markdown, "\r\n", "\n")
	markdown = strings.ReplaceAll(markdown, "\r", "\n")
	lines := strings.Split(readmeCommentRE.ReplaceAllString(markdown, "\n"), "\n")
	headings := []struct {
		Level int
		Title string
	}{}
	sections := []readmeSection{}
	currentTitle, currentLines := "intro", []string{}
	inCode, screenshot := false, false
	pushSection := func() {
		lines := []string{}
		for _, line := range currentLines {
			if clean := cleanReadmeLine(line); clean != "" {
				lines = append(lines, clean)
			}
		}
		sections = append(sections, readmeSection{Title: currentTitle, Text: strings.Join(lines, " ")})
		currentLines = nil
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inCode = !inCode
			continue
		}
		if inCode {
			continue
		}
		for _, image := range readmeImageRE.FindAllStringSubmatch(line, -1) {
			if len(image) > 2 && textMatches(cleanReadmeLine(line)+" "+image[1]+" "+image[2], []string{"screenshot", "screenshots", "screen", "demo", "preview"}) {
				screenshot = true
			}
		}
		if match := readmeHeadingRE.FindStringSubmatch(line); len(match) == 3 {
			pushSection()
			currentTitle = cleanReadmeLine(match[2])
			headings = append(headings, struct {
				Level int
				Title string
			}{Level: len(match[1]), Title: currentTitle})
			continue
		}
		currentLines = append(currentLines, line)
	}
	pushSection()
	usefulParts := make([]string, 0, len(sections))
	for _, section := range sections {
		usefulParts = append(usefulParts, section.Title+" "+section.Text)
	}
	usefulText := strings.Join(usefulParts, " ")
	length := float64(len(meaningfulText(&usefulText)))
	signals := map[string]bool{
		"install":      textMatches(usefulText, []string{"install", "installation", "setup"}),
		"usage":        textMatches(usefulText, []string{"usage", "quickstart", "quick start", "examples?", "guide"}),
		"api":          textMatches(usefulText, []string{"api", "sdk", "reference"}),
		"demo":         textMatches(usefulText, []string{"demo", "preview", "playground"}),
		"features":     textMatches(usefulText, []string{"features?"}),
		"deploy":       textMatches(usefulText, []string{"deploy", "deployment"}),
		"test":         textMatches(usefulText, []string{"test", "testing", "tests"}),
		"architecture": textMatches(usefulText, []string{"architecture", "design", "internals"}),
		"screenshot":   screenshot || textMatches(usefulText, []string{"screenshot", "screenshots", "screen"}),
	}
	placeholderHits := 0
	for _, pattern := range []*regexp.Regexp{regexp.MustCompile(`(?i)\bwip\b`), regexp.MustCompile(`(?i)\btodo\b`), regexp.MustCompile(`(?i)\bscratch\b`), regexp.MustCompile(`(?i)\bplayground only\b`), regexp.MustCompile(`(?i)\blearning notes?\b`)} {
		if pattern.MatchString(usefulText) {
			placeholderHits++
		}
	}
	signalCount := 0
	for _, present := range signals {
		if present {
			signalCount++
		}
	}
	placeholderScore := min(1, float64(placeholderHits)*0.35+map[bool]float64{true: 0.3, false: 0}[length < 300 && placeholderHits > 0])
	contentDepth := min(1, map[bool]float64{true: 0.35, false: 0}[length >= 800]+map[bool]float64{true: 0.2, false: 0}[length >= 300 && length < 800]+map[bool]float64{true: 0.1, false: 0}[length >= 120 && length < 300]+min(float64(len(headings)), 5)*0.06+min(float64(signalCount), 5)*0.07)
	title := ""
	for _, heading := range headings {
		if heading.Level == 1 {
			title = heading.Title
			break
		}
	}
	if title == "" && len(headings) > 0 {
		title = headings[0].Title
	}
	intro := ""
	for _, section := range sections {
		if section.Title == "intro" && section.Text != "" {
			intro = section.Text
			break
		}
	}
	if intro == "" {
		for _, section := range sections {
			if section.Text != "" {
				intro = section.Text
				break
			}
		}
	}
	promptParts := []string{}
	if title != "" {
		promptParts = append(promptParts, "Title: "+title)
	}
	if intro != "" {
		promptParts = append(promptParts, "Intro: "+clampText(intro, 350))
	}
	if len(headings) > 0 {
		list := []string{}
		for i, heading := range headings {
			if i == 12 {
				break
			}
			list = append(list, heading.Title)
		}
		promptParts = append(promptParts, "Sections: "+strings.Join(list, ", "))
	}
	for _, section := range sections {
		if textMatches(section.Title, []string{"install", "installation", "setup", "usage", "quickstart", "quick start", "api", "architecture", "design", "test", "demo", "features?", "deploy", "deployment"}) {
			promptParts = append(promptParts, section.Title+": "+clampText(section.Text, 220))
			if len(promptParts) >= 7 {
				break
			}
		}
	}
	if signalCount > 0 {
		keys := []string{}
		for _, key := range []string{"install", "usage", "api", "demo", "features", "deploy", "test", "architecture", "screenshot"} {
			if signals[key] {
				keys = append(keys, key)
			}
		}
		promptParts = append(promptParts, "Signals: "+strings.Join(keys, ", "))
	}
	return ReadmeFeatures{Length: length, HeadingCount: float64(len(headings)), HasInstall: signals["install"], HasUsage: signals["usage"], HasAPI: signals["api"], HasDemo: signals["demo"], HasFeatures: signals["features"], HasDeploy: signals["deploy"], HasTest: signals["test"], HasArchitecture: signals["architecture"], HasScreenshot: signals["screenshot"], PlaceholderScore: roundJS(placeholderScore*100) / 100, ContentDepthScore: roundJS(contentDepth*100) / 100, PromptSummary: clampText(strings.Join(promptParts, "\n"), readmePromptSummaryLimit)}
}

func topRepoFromGitHub(repo githubRepo, fallbackOwner string, attributed bool, evidence []string) TopRepo {
	owner := fallbackOwner
	if repo.Owner != nil && repo.Owner.Login != "" {
		owner = repo.Owner.Login
	}
	nameWithOwner := repo.FullName
	if nameWithOwner == "" {
		nameWithOwner = owner + "/" + repo.Name
	}
	return TopRepo{Name: repo.Name, OwnerLogin: stringPointer(owner), NameWithOwner: stringPointer(nameWithOwner), Stars: repo.StargazersCount, Forks: repo.ForksCount, OpenIssues: repo.OpenIssuesCount, Size: repo.Size, Language: repo.Language, Description: repo.Description, PushedAt: repo.PushedAt, Topics: append([]string(nil), repo.Topics...), AttributedOriginal: attributed, AttributionEvidence: append([]string(nil), evidence...)}
}

func (c *GitHubClient) fetchRepoDetails(ctx context.Context, owner, repo string) (*githubRepo, error) {
	var detail githubRepo
	if err := c.restGet(ctx, "repos/"+owner+"/"+repo, &detail); err != nil {
		if err == ErrGitHubAccountNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &detail, nil
}

func (c *GitHubClient) hydrateTopRepoEvidence(ctx context.Context, repos []TopRepo, fallbackOwner string, limit int) error {
	if limit > len(repos) {
		limit = len(repos)
	}
	for index := 0; index < limit; index++ {
		owner := valueOrString(repos[index].OwnerLogin, fallbackOwner)
		readme, readmeErr := c.fetchReadmeDocument(ctx, owner, repos[index].Name)
		if readmeErr != nil && readmeErr != ErrGitHubUnavailable {
			return readmeErr
		}
		languages, languageErr := c.fetchRepoLanguages(ctx, owner, repos[index].Name)
		if languageErr != nil && languageErr != ErrGitHubUnavailable {
			return languageErr
		}
		if readme != nil {
			repos[index].Readme = readme
			repos[index].ReadmeExcerpt = stringPointer(readme.Features.PromptSummary)
		}
		repos[index].Languages = languages
	}
	return nil
}

func (c *GitHubClient) hydrateOpenIssueCounts(ctx context.Context, repos []TopRepo) {
	if len(repos) > 10 {
		repos = repos[:10]
	}
	declarations, selections := []string{}, []string{}
	variables := map[string]any{}
	for index, repo := range repos {
		if repo.OwnerLogin == nil || *repo.OwnerLogin == "" || repo.Name == "" {
			continue
		}
		ownerKey, nameKey := fmt.Sprintf("owner%d", index), fmt.Sprintf("name%d", index)
		declarations = append(declarations, "$"+ownerKey+": String!, $"+nameKey+": String!")
		selections = append(selections, fmt.Sprintf("r%d: repository(owner: $%s, name: $%s) { issues(states: OPEN) { totalCount } }", index, ownerKey, nameKey))
		variables[ownerKey], variables[nameKey] = *repo.OwnerLogin, repo.Name
	}
	if len(selections) == 0 {
		return
	}
	query := "query(" + strings.Join(declarations, ", ") + ") { " + strings.Join(selections, " ") + " }"
	var result map[string]struct {
		Issues *struct {
			TotalCount float64 `json:"totalCount"`
		} `json:"issues"`
	}
	if c.graphql(ctx, query, variables, &result) != nil {
		return
	}
	for index := range repos {
		if row, ok := result[fmt.Sprintf("r%d", index)]; ok && row.Issues != nil && row.Issues.TotalCount >= 0 {
			count := row.Issues.TotalCount
			repos[index].OpenIssueCount = &count
		}
	}
}

func hasDocLikeTopic(repo githubRepo) bool {
	for _, topic := range repo.Topics {
		if regexp.MustCompile(`(?i)^(docs?|documentation|website|blog|examples?|templates?|tutorials?|guides?|manual)$`).MatchString(topic) {
			return true
		}
	}
	return false
}

func (c *GitHubClient) hasReleaseOrTagAuthor(ctx context.Context, owner, repo, loginLower string) bool {
	var releases []struct {
		Author *struct {
			Login *string `json:"login"`
		} `json:"author"`
	}
	if c.restGet(ctx, "repos/"+owner+"/"+repo+"/releases?per_page=10", &releases) == nil {
		for _, release := range releases {
			if release.Author != nil && release.Author.Login != nil && strings.EqualFold(*release.Author.Login, loginLower) {
				return true
			}
		}
	}
	var tags []struct {
		Commit *struct {
			SHA *string `json:"sha"`
		} `json:"commit"`
	}
	if c.restGet(ctx, "repos/"+owner+"/"+repo+"/tags?per_page=5", &tags) != nil {
		return false
	}
	for index, tag := range tags {
		if index == 5 {
			break
		}
		if tag.Commit == nil || tag.Commit.SHA == nil || *tag.Commit.SHA == "" {
			continue
		}
		var commit struct {
			Author *struct {
				Login *string `json:"login"`
			} `json:"author"`
			Committer *struct {
				Login *string `json:"login"`
			} `json:"committer"`
		}
		if c.restGet(ctx, "repos/"+owner+"/"+repo+"/commits/"+*tag.Commit.SHA, &commit) == nil && ((commit.Author != nil && commit.Author.Login != nil && strings.EqualFold(*commit.Author.Login, loginLower)) || (commit.Committer != nil && commit.Committer.Login != nil && strings.EqualFold(*commit.Committer.Login, loginLower))) {
			return true
		}
	}
	return false
}

func maintainerTextMatchesUser(text, loginLower string, profileURL *string) bool {
	lower := strings.ToLower(text)
	if regexp.MustCompile(`(^|[^a-z0-9-])@?` + regexp.QuoteMeta(loginLower) + `([^a-z0-9-]|$)`).MatchString(lower) {
		return true
	}
	return profileURL != nil && strings.Contains(lower, strings.ToLower(*profileURL)) || strings.Contains(lower, "github.com/"+strings.ToLower(loginLower))
}

func (c *GitHubClient) hasMaintainerFileHit(ctx context.Context, owner, repo, loginLower string, profileURL *string) bool {
	for _, path := range []string{"MAINTAINERS", "MAINTAINERS.md", "CODEOWNERS", ".github/CODEOWNERS", "docs/MAINTAINERS.md", "docs/maintainers.md"} {
		var file githubReadme
		if c.restGet(ctx, "repos/"+owner+"/"+repo+"/contents/"+path, &file) != nil || file.Content == "" || !strings.EqualFold(file.Encoding, "base64") {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(file.Content), ""))
		if err == nil && maintainerTextMatchesUser(string(decoded), loginLower, profileURL) {
			return true
		}
	}
	return false
}

func (c *GitHubClient) collectAttributedOriginalRepos(ctx context.Context, contributions []ContribRepoAgg, organizations, pinnedRepos []string, loginLower string, profileURL *string) []TopRepo {
	candidates := []ContribRepoAgg{}
	for _, contribution := range contributions {
		if ComputeOrgRepoAttribution(contribution, organizations, pinnedRepos, false, false) != nil {
			candidates = append(candidates, contribution)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].Stars > candidates[j].Stars || (candidates[i].Stars == candidates[j].Stars && candidates[i].Commits+candidates[i].PRs > candidates[j].Commits+candidates[j].PRs)
	})
	if len(candidates) > 8 {
		candidates = candidates[:8]
	}
	result := []TopRepo{}
	for _, candidate := range candidates {
		owner, name, found := strings.Cut(candidate.Repo, "/")
		if !found || owner == "" || name == "" {
			continue
		}
		detail, err := c.fetchRepoDetails(ctx, owner, name)
		if err != nil || detail == nil || detail.Private || detail.Fork || isDocLikeRepo(candidate.Repo) || hasDocLikeTopic(*detail) {
			continue
		}
		attribution := ComputeOrgRepoAttribution(candidate, organizations, pinnedRepos, c.hasReleaseOrTagAuthor(ctx, owner, name, loginLower), c.hasMaintainerFileHit(ctx, owner, name, loginLower, profileURL))
		if attribution != nil {
			result = append(result, topRepoFromGitHub(*detail, owner, true, attribution.Evidence))
		}
	}
	return result
}
