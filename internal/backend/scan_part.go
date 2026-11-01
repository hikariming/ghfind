package backend

import "fmt"

// Scan part names are the durable idempotency key together with the parent
// scan id. Search-backed parts stay in one lane so secondary rate limits
// are not fanned out across consumers.
const (
	scanPhaseSeed     = "seed"
	scanPhasePart     = "part"
	scanPhaseAssemble = "assemble"

	scanPartRepos      = "repos"
	scanPartExternal   = "external_prs"
	scanPartMerged     = "merged_window"
	scanPartCommits    = "commits_by_year"
	scanPartWorkflows  = "workflows"
	scanPartDependents = "dependents"

	scanSourceQuick            = "quick"
	scanSourceOriginalRepos    = "original_repos"
	scanSourceNativePRs        = "native_prs"
	scanSourceWorkflowLandings = "workflow_landings"
	scanSourceCommitRecovery   = "commit_recovery"
	scanSourceStatePending     = "pending"
	scanSourceStateComplete    = "complete"
	scanSourceStateUnavailable = "unavailable"
	scanSourceStateFailed      = "failed"
	maxScanFanoutParts         = 4
	// One core point is the cheapest GraphQL/REST call the seed already
	// spent. A part is scheduled only when the observed remainder can cover
	// that call; an unseen header does not block a split the inventory
	// already asked for.
	scanPartPointCost = 1
)

// ScanPartJob is one independently consumable slice of a parent scan.
// ParentID is the public_scan_runs id. Repeating (username, parent, part)
// is safe: the parent records the first successful payload and ignores a
// later copy of the same part.
type ScanPartJob struct {
	ParentID    string `json:"parent_id"`
	Username    string `json:"username"`
	Phase       string `json:"phase"`
	Part        string `json:"part"`
	Attempt     int    `json:"attempt"`
	RequestedAt int64  `json:"requested_at"`
	Full        bool   `json:"full"`
	Lane        int    `json:"lane"`
	// Since is the repo pushedAt watermark when this part is an incremental
	// inventory delta. Empty means the part pulls its existing window.
	// Merged and external PR parts ignore it: those connections are ordered
	// by created time, not mergedAt.
	Since string `json:"since,omitempty"`
}

func (j ScanPartJob) MessageID() string {
	return fmt.Sprintf("%s:%s", j.ParentID, j.Part)
}

// ScanAssembleJob runs only after every planned part has a terminal record.
type ScanAssembleJob struct {
	ParentID    string `json:"parent_id"`
	Username    string `json:"username"`
	Phase       string `json:"phase"`
	Attempt     int    `json:"attempt"`
	RequestedAt int64  `json:"requested_at"`
	Full        bool   `json:"full"`
	LookupHash  string `json:"lookup_hash,omitempty"`
	Campaign    string `json:"campaign,omitempty"`
	FlightLock  bool   `json:"flight_lock,omitempty"`
}

func (j ScanAssembleJob) MessageID() string {
	return j.ParentID + ":assemble"
}

func (j ScanAssembleJob) asScanJob() ScanJob {
	return ScanJob{
		ID:          j.ParentID,
		Username:    j.Username,
		Attempt:     j.Attempt,
		RequestedAt: j.RequestedAt,
		LookupHash:  j.LookupHash,
		Campaign:    j.Campaign,
		FlightLock:  j.FlightLock,
	}
}

// scanSeedSignals are the cheap facts available after GetUser and the
// contribution overview. Thresholds that decide a split come from the same
// constants the in-process collector uses to escalate.
type scanSeedSignals struct {
	PublicRepos float64
	MergedPRs   float64
	ClosedPRs   float64
	// ExternalAtCap is true when the overview already says the external
	// merged window will touch externalMergedPRCap. The seed does not run
	// Search; the cap comparison uses the merged total as the upper bound.
	ExternalAtCap bool
	Full          bool
	// RateRemaining is the tightest core X-RateLimit-Remaining observed on
	// the seed. RateKnown is false when the header was absent.
	RateRemaining int
	RateKnown     bool
}

// scanFanoutPlan is the ordered work for one heavy scan. SearchParts run
// one after another. ParallelParts may be consumed by different workers.
// InlineParts are the lightest sources that did not fit in the four-part
// cap; assemble runs them once so a split scan still sees every source.
// Dependents run after every enqueued part has finished.
type scanFanoutPlan struct {
	Split         bool
	SearchParts   []string
	ParallelParts []string
	InlineParts   []string
	Dependents    []string
}

func (p scanFanoutPlan) parts() []string {
	out := make([]string, 0, len(p.SearchParts)+len(p.ParallelParts)+len(p.Dependents))
	out = append(out, p.SearchParts...)
	out = append(out, p.ParallelParts...)
	out = append(out, p.Dependents...)
	return out
}

// planScanFanout decides whether a scan stays inside the current process.
// A light account, or a pool that cannot cover one more call per part,
// keeps the in-process Collect path. A heavy account splits at most
// maxScanFanoutParts independent parts. Search stays serial.
func planScanFanout(signals scanSeedSignals) scanFanoutPlan {
	heavy := signals.Full ||
		signals.PublicRepos > float64(quickRepoPages*githubPageSize) ||
		signals.MergedPRs > float64(mergedPRWindow) ||
		signals.ExternalAtCap ||
		signals.ClosedPRs > float64(githubPageSize)
	if !heavy {
		return scanFanoutPlan{}
	}
	candidates := []partCandidate{
		{name: scanPartRepos, search: false, weight: signals.PublicRepos},
		{name: scanPartExternal, search: true, weight: signals.MergedPRs},
		{name: scanPartMerged, search: false, weight: signals.MergedPRs},
		{name: scanPartCommits, search: false, weight: signals.PublicRepos + signals.MergedPRs},
		{name: scanPartWorkflows, search: false, weight: signals.ClosedPRs},
	}
	selected := selectFanoutParts(candidates, signals)
	if len(selected) == 0 {
		return scanFanoutPlan{}
	}
	chosen := map[string]bool{}
	plan := scanFanoutPlan{Split: true, Dependents: []string{scanPartDependents}}
	for _, part := range selected {
		chosen[part.name] = true
		if part.search {
			plan.SearchParts = append(plan.SearchParts, part.name)
			continue
		}
		plan.ParallelParts = append(plan.ParallelParts, part.name)
	}
	for _, candidate := range candidates {
		if !chosen[candidate.name] {
			plan.InlineParts = append(plan.InlineParts, candidate.name)
		}
	}
	return plan
}

type partCandidate struct {
	name   string
	search bool
	weight float64
}

// selectFanoutParts keeps the heaviest parts up to the cap, then drops any
// part the observed token remainder cannot pay for. Search parts are kept
// when they win the weight order; the caller still runs them serially.
func selectFanoutParts(candidates []partCandidate, signals scanSeedSignals) []partCandidate {
	ordered := append([]partCandidate(nil), candidates...)
	// Heavier first. Equal weights keep declaration order so the plan is
	// stable across processes.
	for i := 1; i < len(ordered); i++ {
		for j := i; j > 0 && ordered[j].weight > ordered[j-1].weight; j-- {
			ordered[j], ordered[j-1] = ordered[j-1], ordered[j]
		}
	}
	limit := maxScanFanoutParts
	if signals.RateKnown {
		affordable := signals.RateRemaining / scanPartPointCost
		if affordable < 1 {
			return nil
		}
		if affordable < limit {
			limit = affordable
		}
	}
	if limit > len(ordered) {
		limit = len(ordered)
	}
	return ordered[:limit]
}

func pendingSourceStatus() map[string]string {
	return map[string]string{
		scanSourceQuick:            scanSourceStatePending,
		scanSourceOriginalRepos:    scanSourceStatePending,
		scanSourceNativePRs:        scanSourceStatePending,
		scanSourceWorkflowLandings: scanSourceStatePending,
		scanSourceCommitRecovery:   scanSourceStatePending,
	}
}
