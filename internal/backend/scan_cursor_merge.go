package backend

import (
	"strings"
	"time"
)

// scanCursorAdvance is what one source pull learned. Full means the page
// was a reconciliation, so the stored baseline is replaced. Otherwise the
// items are a delta that must be merged into the previous snapshot.
type scanCursorAdvance struct {
	Source string
	Full   bool
	Items  []scanCursorItem
	// Dropped lists keys that a reconciliation proved are gone. Incremental
	// pulls leave this empty: deletes, renames, and force-push drift wait
	// for the next full reconcile.
	Dropped []string
}

// scanCursorItem is one timestamped fact from a source page. Key is stable
// across incremental and full pulls of the same GitHub object.
type scanCursorItem struct {
	Key       string
	Timestamp string
	Repo      *githubRepo
	Node      *mergedPRNode
}

// mergeScanCursorItems folds a delta into the previous snapshot.
// A full advance replaces the snapshot, then drops keys the page no longer
// returned. An incremental advance upserts by key and never deletes.
// The result is ordered newest-first, matching the GraphQL orderBy DESC
// pages the collectors already consume.
func mergeScanCursorItems(previous []scanCursorItem, advance scanCursorAdvance) []scanCursorItem {
	byKey := map[string]scanCursorItem{}
	order := []string{}
	remember := func(item scanCursorItem) {
		if item.Key == "" {
			return
		}
		if _, seen := byKey[item.Key]; !seen {
			order = append(order, item.Key)
		}
		byKey[item.Key] = item
	}
	if !advance.Full {
		for _, item := range previous {
			remember(item)
		}
	}
	for _, item := range advance.Items {
		remember(item)
	}
	if advance.Full && len(advance.Dropped) > 0 {
		drop := map[string]bool{}
		for _, key := range advance.Dropped {
			drop[key] = true
		}
		kept := make([]string, 0, len(order))
		for _, key := range order {
			if drop[key] {
				delete(byKey, key)
				continue
			}
			kept = append(kept, key)
		}
		order = kept
	}
	out := make([]scanCursorItem, 0, len(order))
	for _, key := range order {
		out = append(out, byKey[key])
	}
	sortCursorItemsNewestFirst(out)
	return out
}

func sortCursorItemsNewestFirst(items []scanCursorItem) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && cursorItemAfter(items[j], items[j-1]); j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

func cursorItemAfter(a, b scanCursorItem) bool {
	left, leftOK := parseTimestamp(&a.Timestamp)
	right, rightOK := parseTimestamp(&b.Timestamp)
	if leftOK && rightOK && !left.Equal(right) {
		return left.After(right)
	}
	if leftOK != rightOK {
		return leftOK
	}
	return a.Key > b.Key
}

// cursorWatermarkFromItems records the newest timestamp in the merged page.
// Resume is that timestamp, not a GraphQL cursor. An incremental advance
// keeps the previous reconcile time so the age threshold stays anchored
// to the last full read.
func cursorWatermarkFromItems(source string, items []scanCursorItem, prev scanCursorWatermark, reconciled bool, now time.Time) scanCursorWatermark {
	mark := scanCursorWatermark{
		Source:     source,
		Collection: goCanonicalCollectionVersion,
		UpdatedAt:  now.UTC().Format(time.RFC3339),
	}
	if reconciled {
		mark.ReconciledAt = mark.UpdatedAt
		mark.IncrementalRuns = 0
	} else {
		mark.ReconciledAt = prev.ReconciledAt
		if mark.ReconciledAt == "" {
			mark.ReconciledAt = prev.UpdatedAt
		}
		mark.IncrementalRuns = prev.IncrementalRuns + 1
	}
	newest := ""
	for _, item := range items {
		if item.Timestamp == "" {
			continue
		}
		if newest == "" || cursorAfterWatermark(item.Timestamp, newest) {
			newest = item.Timestamp
		}
	}
	mark.Watermark = newest
	switch source {
	case scanCursorRepos:
		mark.Repos = reposFromCursorItems(items)
		mark.ForkCount = prev.ForkCount
	case scanCursorExternal, scanCursorMerged:
		mark.Nodes = nodesFromCursorItems(items)
	}
	return mark
}

func repoCursorKey(repo githubRepo) string {
	if repo.FullName != "" {
		return strings.ToLower(repo.FullName)
	}
	return strings.ToLower(repo.Name)
}

func repoCursorItem(repo githubRepo) scanCursorItem {
	copy := repo
	stamp := ""
	if repo.PushedAt != nil {
		stamp = *repo.PushedAt
	}
	return scanCursorItem{Key: repoCursorKey(repo), Timestamp: stamp, Repo: &copy}
}

func nodeCursorKey(node mergedPRNode) string {
	if node.ID != nil && *node.ID != "" {
		return *node.ID
	}
	repo := ""
	if node.Repository != nil {
		repo = node.Repository.NameWithOwner
	}
	stamp := ""
	if node.MergedAt != nil {
		stamp = *node.MergedAt
	}
	return repo + "@" + stamp
}

func nodeCursorItem(node mergedPRNode) scanCursorItem {
	copy := node
	stamp := ""
	if node.MergedAt != nil {
		stamp = *node.MergedAt
	}
	return scanCursorItem{Key: nodeCursorKey(node), Timestamp: stamp, Node: &copy}
}

func reposFromCursorItems(items []scanCursorItem) []githubRepo {
	out := make([]githubRepo, 0, len(items))
	for _, item := range items {
		if item.Repo == nil {
			continue
		}
		out = append(out, *item.Repo)
	}
	return out
}

func nodesFromCursorItems(items []scanCursorItem) []mergedPRNode {
	out := make([]mergedPRNode, 0, len(items))
	for _, item := range items {
		if item.Node == nil {
			continue
		}
		out = append(out, *item.Node)
	}
	return out
}

// scanSnapshotBaseline is the previous source snapshot an incremental pull
// merges into. Tests and the worker pass the last persisted page; an empty
// baseline makes the delta the whole result, which still matches a full
// scan of the same delta.
type scanSnapshotBaseline struct {
	Repos     []githubRepo
	ForkCount float64
	External  []mergedPRNode
	Merged    []mergedPRNode
}

func (b scanSnapshotBaseline) items(source string) []scanCursorItem {
	switch source {
	case scanCursorRepos:
		out := make([]scanCursorItem, 0, len(b.Repos))
		for _, repo := range b.Repos {
			out = append(out, repoCursorItem(repo))
		}
		return out
	case scanCursorExternal:
		return nodesToCursorItems(b.External)
	case scanCursorMerged:
		return nodesToCursorItems(b.Merged)
	default:
		return nil
	}
}

func nodesToCursorItems(nodes []mergedPRNode) []scanCursorItem {
	out := make([]scanCursorItem, 0, len(nodes))
	for _, node := range nodes {
		out = append(out, nodeCursorItem(node))
	}
	return out
}

// applyIncrementalPayload merges a part delta into the stored baseline when
// the part was collected incrementally. A full part replaces that source.
func applyIncrementalPayload(baseline scanSnapshotBaseline, payload scanPartPayload, full bool) (scanSnapshotBaseline, scanPartPayload) {
	if full || payload.Failed {
		return foldPayloadBaseline(baseline, payload), payload
	}
	switch payload.Part {
	case scanPartRepos:
		merged := mergeScanCursorItems(baseline.items(scanCursorRepos), scanCursorAdvance{
			Source: scanCursorRepos, Items: reposToCursorItems(payload.Repos),
		})
		payload.Repos = reposFromCursorItems(merged)
		if baseline.ForkCount > 0 {
			payload.ForkCount = baseline.ForkCount
		}
		baseline.Repos = payload.Repos
		baseline.ForkCount = payload.ForkCount
	case scanPartExternal:
		if payload.External != nil {
			merged := mergeScanCursorItems(baseline.items(scanCursorExternal), scanCursorAdvance{
				Source: scanCursorExternal, Items: nodesToCursorItems(payload.External.Nodes),
			})
			payload.External.Nodes = nodesFromCursorItems(merged)
			if float64(len(payload.External.Nodes)) > payload.External.Total {
				payload.External.Total = float64(len(payload.External.Nodes))
			}
			baseline.External = payload.External.Nodes
		}
	case scanPartMerged:
		merged := mergeScanCursorItems(baseline.items(scanCursorMerged), scanCursorAdvance{
			Source: scanCursorMerged, Items: nodesToCursorItems(payload.WindowNodes),
		})
		payload.WindowNodes = nodesFromCursorItems(merged)
		baseline.Merged = payload.WindowNodes
	}
	return baseline, payload
}

func reposToCursorItems(repos []githubRepo) []scanCursorItem {
	out := make([]scanCursorItem, 0, len(repos))
	for _, repo := range repos {
		out = append(out, repoCursorItem(repo))
	}
	return out
}

func foldPayloadBaseline(baseline scanSnapshotBaseline, payload scanPartPayload) scanSnapshotBaseline {
	switch payload.Part {
	case scanPartRepos:
		baseline.Repos = append([]githubRepo(nil), payload.Repos...)
		baseline.ForkCount = payload.ForkCount
	case scanPartExternal:
		if payload.External != nil {
			baseline.External = append([]mergedPRNode(nil), payload.External.Nodes...)
		}
	case scanPartMerged:
		baseline.Merged = append([]mergedPRNode(nil), payload.WindowNodes...)
	}
	return baseline
}
