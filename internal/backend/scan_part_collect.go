package backend

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// scanPartPayload is the durable body of one finished part. Assemble reads
// these back and feeds the same scoring inputs the in-process collector
// builds. A failed part stores the error class and leaves its sources
// incomplete so the scan can still publish as partial_public.
type scanPartPayload struct {
	Part   string `json:"part"`
	Failed bool   `json:"failed,omitempty"`
	Error  string `json:"error,omitempty"`

	Repos           []githubRepo `json:"repos,omitempty"`
	ForkCount       float64      `json:"fork_count,omitempty"`
	ReposIncomplete bool         `json:"repos_incomplete,omitempty"`

	External          *externalMergedPRs `json:"external,omitempty"`
	ExternalMissing   bool               `json:"external_missing,omitempty"`
	WindowNodes       []mergedPRNode     `json:"window_nodes,omitempty"`
	MergedIncomplete  bool               `json:"merged_incomplete,omitempty"`
	CommitContribs    []ContribRepoAgg   `json:"commit_contribs,omitempty"`
	CommitUnavailable bool               `json:"commit_unavailable,omitempty"`
	CommitReasons     []string           `json:"commit_reasons,omitempty"`
	WorkflowLanded    []workflowLandedPR `json:"workflow_landed,omitempty"`
	WorkflowReasons   []string           `json:"workflow_reasons,omitempty"`

	// Dependents carry the hydrated facts assemble would otherwise recompute
	// from the independent parts. They are optional: assemble can rebuild
	// them when this part failed.
	Organizations []string `json:"organizations,omitempty"`

	// Incremental marks a repo delta that assemble merges into the stored
	// inventory page. A full reconcile leaves it false and replaces that page.
	Incremental bool `json:"incremental,omitempty"`
}

// CollectScanPart runs one named slice. Search parts are the caller's
// responsibility to serialize. A nil payload with a non-nil error is a
// retryable transport failure. A payload with Failed set is a recorded
// source failure that still lets assemble publish.
func (c *GitHubCollector) CollectScanPart(ctx context.Context, username, part string, full bool, seed githubUser, overview contributionOverview) (scanPartPayload, error) {
	payload := scanPartPayload{Part: part}
	if c == nil || c.github == nil || !c.github.HasToken() {
		return payload, ErrGitHubAuthRequired
	}
	login := seed.Login
	if login == "" {
		login = username
	}
	switch part {
	case scanPartRepos:
		repos, forks, incomplete, err := c.github.ownedOriginalInventory(ctx, login, full)
		if err != nil {
			return payload, err
		}
		payload.Repos = repos
		payload.ForkCount = forks
		payload.ReposIncomplete = incomplete
	case scanPartExternal:
		// Full scans derive external PRs from the native merged window.
		// Recording an empty search result here would drop that derivation.
		if full {
			break
		}
		external, err := c.github.fetchExternalMergedPRs(ctx, login, externalMergedPRCap)
		if err != nil {
			return payload, err
		}
		if external == nil {
			payload.ExternalMissing = true
			break
		}
		payload.External = external
	case scanPartMerged:
		limit := mergedPRWindow
		if full {
			limit = int(^uint(0) >> 1)
		}
		nodes, err := c.github.fetchMergedPRNodes(ctx, login, limit)
		if errors.Is(err, ErrGitHubResourceLimit) {
			payload.MergedIncomplete = true
			break
		}
		if err != nil {
			return payload, err
		}
		payload.WindowNodes = nodes
		if !full && overview.MergedPRCount > float64(mergedPRWindow) {
			payload.MergedIncomplete = true
		}
	case scanPartCommits:
		scope := &collectionScope{Full: full}
		contribs, err := c.github.fetchCommitContribReposByYear(ctx, login, overview.ContributionYears, scope)
		if errors.Is(err, ErrGitHubResourceLimit) {
			scope.note("commit_resource_limit")
			err = nil
		}
		if err != nil {
			return payload, err
		}
		payload.CommitContribs = contribs
		payload.CommitReasons = append([]string(nil), scope.Reasons...)
		if len(overview.ContributionYears) > 0 && contribs == nil {
			payload.CommitUnavailable = true
		}
	case scanPartWorkflows:
		scope := &collectionScope{Full: full}
		landed, err := c.github.fetchWorkflowLandedPRs(ctx, login, overview.ClosedPRCount, scope)
		if err != nil {
			return payload, err
		}
		payload.WorkflowLanded = landed
		payload.WorkflowReasons = append([]string(nil), scope.Reasons...)
	case scanPartDependents:
		orgs, err := c.github.fetchOrganizations(ctx, login)
		if err != nil {
			return payload, err
		}
		payload.Organizations = orgs
	default:
		return payload, errors.New("unknown scan part")
	}
	return payload, nil
}

// assembleCollectedScan stitches recorded parts into the same ScanResult the
// in-process collector returns for the same inputs. Missing or failed parts
// become truncation reasons and per-source states; they do not invent facts.
func (c *GitHubCollector) assembleCollectedScan(
	ctx context.Context,
	full bool,
	user githubUser,
	overview contributionOverview,
	stats *contribStats,
	lastYear float64,
	latestEvent *time.Time,
	parts map[string]scanPartPayload,
) (ScanResult, map[string]string, error) {
	login, loginLower := user.Login, strings.ToLower(user.Login)
	now := c.clock().UTC()
	sources := pendingSourceStatus()
	sources[scanSourceQuick] = scanSourceStateComplete

	reposPayload, reposOK := parts[scanPartRepos]
	externalPayload, externalOK := parts[scanPartExternal]
	mergedPayload, mergedOK := parts[scanPartMerged]
	commitPayload, commitOK := parts[scanPartCommits]
	workflowPayload, workflowOK := parts[scanPartWorkflows]

	reasons := []string{}
	if !reposOK || reposPayload.Failed {
		sources[scanSourceOriginalRepos] = failedOrMissing(reposOK, reposPayload.Failed)
		reasons = append(reasons, "original_repos_unavailable")
	} else {
		sources[scanSourceOriginalRepos] = scanSourceStateComplete
		if reposPayload.ReposIncomplete {
			reasons = append(reasons, "original_repos_page_limit")
		}
	}
	if !full && user.PublicRepos > float64(quickRepoPages*githubPageSize) {
		reasons = append(reasons, "public_repos_quick_limit")
	}

	var external *externalMergedPRs
	if full && mergedOK && !mergedPayload.Failed {
		external = &externalMergedPRs{Nodes: []mergedPRNode{}}
		for _, node := range mergedPayload.WindowNodes {
			if node.Repository != nil && !node.Repository.IsPrivate && !strings.EqualFold(ownerLoginFromRepo(node.Repository.NameWithOwner), login) {
				external.Nodes = append(external.Nodes, node)
			}
		}
		external.Total = float64(len(external.Nodes))
		sources[scanSourceNativePRs] = scanSourceStateComplete
	} else if externalOK && !externalPayload.Failed {
		if externalPayload.ExternalMissing || externalPayload.External == nil {
			reasons = append(reasons, "external_merged_unavailable")
			sources[scanSourceNativePRs] = scanSourceStateUnavailable
		} else {
			external = externalPayload.External
			sources[scanSourceNativePRs] = scanSourceStateComplete
			if !full && (external.Total >= float64(externalMergedPRCap) || len(external.Nodes) >= externalMergedPRCap) {
				reasons = append(reasons, "external_merged_pr_cap")
			}
		}
	} else {
		reasons = append(reasons, "external_merged_unavailable")
		sources[scanSourceNativePRs] = failedOrMissing(externalOK, externalPayload.Failed)
	}

	windowNodes := []mergedPRNode{}
	mergedIncomplete := !full && overview.MergedPRCount > float64(mergedPRWindow)
	if mergedOK && !mergedPayload.Failed {
		windowNodes = mergedPayload.WindowNodes
		if mergedPayload.MergedIncomplete {
			mergedIncomplete = true
		}
	} else if sources[scanSourceNativePRs] == scanSourceStateComplete {
		sources[scanSourceNativePRs] = failedOrMissing(mergedOK, mergedPayload.Failed)
	} else if !mergedOK || mergedPayload.Failed {
		sources[scanSourceNativePRs] = failedOrMissing(mergedOK, mergedPayload.Failed)
	}
	if mergedIncomplete {
		reasons = append(reasons, "merged_pr_window")
	}

	commitContribs := []ContribRepoAgg{}
	commitUnavailable := len(overview.ContributionYears) > 0
	if commitOK && !commitPayload.Failed {
		commitContribs = commitPayload.CommitContribs
		commitUnavailable = commitPayload.CommitUnavailable
		reasons = append(reasons, commitPayload.CommitReasons...)
		if commitUnavailable {
			sources[scanSourceCommitRecovery] = scanSourceStateUnavailable
		} else {
			sources[scanSourceCommitRecovery] = scanSourceStateComplete
		}
	} else {
		sources[scanSourceCommitRecovery] = failedOrMissing(commitOK, commitPayload.Failed)
	}
	if commitUnavailable {
		reasons = append(reasons, "commit_aggregation_unavailable")
	}

	workflowLanded := []workflowLandedPR{}
	if workflowOK && !workflowPayload.Failed {
		workflowLanded = workflowPayload.WorkflowLanded
		reasons = append(reasons, workflowPayload.WorkflowReasons...)
		if containsReason(workflowPayload.WorkflowReasons, "workflow_unavailable") {
			sources[scanSourceWorkflowLandings] = scanSourceStateUnavailable
		} else {
			sources[scanSourceWorkflowLandings] = scanSourceStateComplete
		}
	} else {
		sources[scanSourceWorkflowLandings] = failedOrMissing(workflowOK, workflowPayload.Failed)
		reasons = append(reasons, "workflow_unavailable")
	}

	repos := []githubRepo{}
	forkCount := 0.0
	if reposOK && !reposPayload.Failed {
		repos = reposPayload.Repos
		forkCount = reposPayload.ForkCount
	}
	organizations := []string{}
	if dependents, ok := parts[scanPartDependents]; ok && !dependents.Failed {
		organizations = dependents.Organizations
	} else if c != nil && c.github != nil {
		fetched, err := c.github.fetchOrganizations(ctx, login)
		if err != nil {
			return ScanResult{}, sources, err
		}
		organizations = fetched
	}

	scan, err := c.finishCollectedScan(ctx, finishScanInput{
		Full:              full,
		Now:               now,
		User:              user,
		Login:             login,
		LoginLower:        loginLower,
		Overview:          overview,
		Stats:             stats,
		LastYear:          lastYear,
		LatestEvent:       latestEvent,
		Repos:             repos,
		ForkCount:         forkCount,
		Organizations:     organizations,
		CommitContribs:    commitContribs,
		WorkflowLanded:    workflowLanded,
		External:          external,
		WindowNodes:       windowNodes,
		Reasons:           reasons,
		MergedIncomplete:  mergedIncomplete,
		CommitUnavailable: commitUnavailable,
	})
	if err != nil {
		return ScanResult{}, sources, err
	}
	return scan, sources, nil
}

// mergedSourceStatus keeps a recorded part failure even when another
// truncation reason would only mark that source pending.
func mergedSourceStatus(scan ScanResult, partSources map[string]string) json.RawMessage {
	merged := map[string]string{}
	if err := json.Unmarshal([]byte(scanSourceStatus(scan)), &merged); err != nil {
		merged = map[string]string{}
	}
	for source, state := range partSources {
		if state == scanSourceStateFailed || merged[source] == "" || merged[source] == scanSourceStateComplete {
			merged[source] = state
		}
	}
	encoded, err := json.Marshal(merged)
	if err != nil {
		return nil
	}
	return encoded
}

func failedOrMissing(present, failed bool) string {
	if present && failed {
		return scanSourceStateFailed
	}
	if !present {
		return scanSourceStateFailed
	}
	return scanSourceStateUnavailable
}

func containsReason(reasons []string, want string) bool {
	for _, reason := range reasons {
		if reason == want {
			return true
		}
	}
	return false
}

// finishScanInput is the shared factual bundle both the in-process collector
// and assemble pass into scoring. It carries no GitHub credentials.
type finishScanInput struct {
	Full              bool
	Now               time.Time
	User              githubUser
	Login             string
	LoginLower        string
	Overview          contributionOverview
	Stats             *contribStats
	LastYear          float64
	LatestEvent       *time.Time
	Repos             []githubRepo
	ForkCount         float64
	Organizations     []string
	CommitContribs    []ContribRepoAgg
	WorkflowLanded    []workflowLandedPR
	External          *externalMergedPRs
	WindowNodes       []mergedPRNode
	Reasons           []string
	MergedIncomplete  bool
	CommitUnavailable bool
}
