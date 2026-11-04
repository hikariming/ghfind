package scoring

// Evidence shapes the formula reads. They are also part of the collector wire
// format, so JSON tags must stay identical to src/lib/types.ts.

type PRFileChange struct {
	Path      string  `json:"path"`
	Additions float64 `json:"additions"`
	Deletions float64 `json:"deletions"`
}

type RecentPR struct {
	PresentationShare *float64       `json:"presentation_share,omitempty"`
	FileChanges       []PRFileChange `json:"file_changes,omitempty"`
	Title             *string        `json:"title"`
	Repo              *string        `json:"repo"`
	RepoStars         float64        `json:"repo_stars"`
	Churn             float64        `json:"churn"`
	ChangedFiles      float64        `json:"changed_files"`
	Trivial           bool           `json:"trivial"`
	Files             []string       `json:"files,omitempty"`
}

type ImpactRepo struct {
	Repo    string  `json:"repo"`
	Stars   float64 `json:"stars"`
	Commits float64 `json:"commits"`
	PRs     float64 `json:"prs"`
}
