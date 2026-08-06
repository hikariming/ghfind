package backend

import (
	"context"
	"fmt"
	"strings"
)

type workflowTimelineEvent struct {
	Type      string  `json:"__typename"`
	CreatedAt *string `json:"createdAt"`
	Actor     *struct {
		Login *string `json:"login"`
		Type  string  `json:"__typename"`
	} `json:"actor"`
	Label *struct {
		Name *string `json:"name"`
	} `json:"label"`
}

type workflowPRNode struct {
	Type          string                 `json:"__typename"`
	ID            string                 `json:"id"`
	MergedAt      *string                `json:"mergedAt"`
	Repository    *graphContributionRepo `json:"repository"`
	TimelineItems *struct {
		Nodes []workflowTimelineEvent `json:"nodes"`
	} `json:"timelineItems"`
}

func isOfficialMergeBotActor(actor *struct {
	Login *string `json:"login"`
	Type  string  `json:"__typename"`
}) bool {
	if actor == nil || actor.Login == nil || *actor.Login == "" {
		return false
	}
	login := strings.ToLower(*actor.Login)
	return actor.Type == "Bot" || strings.HasSuffix(login, "mergebot") || strings.HasSuffix(login, "merge-bot") || strings.HasSuffix(login, "landbot") || strings.HasSuffix(login, "land-bot")
}

// isWorkflowLandedPR keeps the strict two-event proof used by the Node
// collector: an official bot applies exactly Merged, then the same bot closes.
func isWorkflowLandedPR(node workflowPRNode) bool {
	if node.MergedAt != nil || node.Repository == nil || node.Repository.IsPrivate || node.Repository.IsFork || node.TimelineItems == nil {
		return false
	}
	for _, merged := range node.TimelineItems.Nodes {
		if merged.Type != "LabeledEvent" || merged.Label == nil || merged.Label.Name == nil || !strings.EqualFold(strings.TrimSpace(*merged.Label.Name), "merged") || !isOfficialMergeBotActor(merged.Actor) || merged.CreatedAt == nil {
			continue
		}
		bot := strings.ToLower(*merged.Actor.Login)
		for _, closed := range node.TimelineItems.Nodes {
			if closed.Type == "ClosedEvent" && closed.CreatedAt != nil && *closed.CreatedAt >= *merged.CreatedAt && isOfficialMergeBotActor(closed.Actor) && strings.EqualFold(*closed.Actor.Login, bot) {
				return true
			}
		}
	}
	return false
}

type workflowLandedPR struct {
	ID         string
	Repo       string
	Stars      float64
	OwnerLogin string
}

func (c *GitHubClient) fetchWorkflowLandedPRs(ctx context.Context, username string, closedPRCount float64) ([]workflowLandedPR, error) {
	if closedPRCount == 0 {
		return []workflowLandedPR{}, nil
	}
	var candidates struct {
		User *struct {
			PullRequests *struct {
				Nodes []struct {
					ID     string `json:"id"`
					Labels *struct {
						Nodes []struct {
							Name *string `json:"name"`
						} `json:"nodes"`
					} `json:"labels"`
				} `json:"nodes"`
			} `json:"pullRequests"`
		} `json:"user"`
	}
	candidateQuery := `query($login: String!) {
  user(login: $login) {
    pullRequests(first: 100, states: CLOSED, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { id labels(first: 20) { nodes { name } } }
    }
  }
}`
	if err := c.graphql(ctx, candidateQuery, map[string]any{"login": username}, &candidates); err != nil {
		// Optional enrichment: preserve native GitHub merge results on failure.
		return []workflowLandedPR{}, nil
	}
	ids := []string{}
	if candidates.User != nil && candidates.User.PullRequests != nil {
		for _, candidate := range candidates.User.PullRequests.Nodes {
			for _, label := range safeLabelNodes(candidate.Labels) {
				if label.Name != nil && strings.EqualFold(strings.TrimSpace(*label.Name), "merged") {
					ids = append(ids, candidate.ID)
					break
				}
			}
			if len(ids) == 25 {
				break
			}
		}
	}
	if len(ids) == 0 {
		return []workflowLandedPR{}, nil
	}
	return c.fetchWorkflowLandedByIDs(ctx, ids)
}

func safeLabelNodes(labels *struct {
	Nodes []struct {
		Name *string `json:"name"`
	} `json:"nodes"`
}) []struct {
	Name *string `json:"name"`
} {
	if labels == nil {
		return nil
	}
	return labels.Nodes
}

func (c *GitHubClient) fetchWorkflowLandedByIDs(ctx context.Context, ids []string) ([]workflowLandedPR, error) {
	var result struct {
		Nodes []workflowPRNode `json:"nodes"`
	}
	query := `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      __typename id mergedAt
      repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
      timelineItems(last: 20, itemTypes: [LABELED_EVENT, CLOSED_EVENT]) {
        nodes {
          __typename
          ... on LabeledEvent { createdAt actor { login __typename } label { name } }
          ... on ClosedEvent { createdAt actor { login __typename } }
        }
      }
    }
  }
}`
	if err := c.graphql(ctx, query, map[string]any{"ids": ids}, &result); err != nil {
		return []workflowLandedPR{}, nil
	}
	landed := []workflowLandedPR{}
	for _, node := range result.Nodes {
		if node.Type != "PullRequest" || !isWorkflowLandedPR(node) {
			continue
		}
		repo := node.Repository
		owner := ownerLoginFromRepo(repo.NameWithOwner)
		if repo.Owner != nil && repo.Owner.Login != nil {
			owner = *repo.Owner.Login
		}
		if repo.NameWithOwner == "" || owner == "" {
			return nil, fmt.Errorf("workflow landing has invalid repository: %w", ErrGitHubUnavailable)
		}
		landed = append(landed, workflowLandedPR{ID: node.ID, Repo: repo.NameWithOwner, Stars: repo.StargazerCount, OwnerLogin: owner})
	}
	return landed, nil
}
