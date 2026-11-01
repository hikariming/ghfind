package backend

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// Match the existing TS/Python resolution order; never infer a login from a
// display name or arbitrary email domain.
func resolveFirstCommitLogin(author, committer, authorEmail, committerEmail string) string {
	if login := strings.TrimSpace(author); login != "" {
		return login
	}
	if login := strings.TrimSpace(committer); login != "" {
		return login
	}
	noreply := regexp.MustCompile(`(?i)^(?:[0-9]+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$`)
	for _, email := range []string{authorEmail, committerEmail} {
		if match := noreply.FindStringSubmatch(email); len(match) == 2 {
			return match[1]
		}
	}
	return ""
}

type firstCommitActor struct {
	Email string `json:"email"`
	User  *struct {
		Login string `json:"login"`
	} `json:"user"`
}
type firstCommitNode struct {
	OID       string            `json:"oid"`
	Author    *firstCommitActor `json:"author"`
	Committer *firstCommitActor `json:"committer"`
}
type firstCommitResponse struct {
	Repository *struct {
		IsFork           bool `json:"isFork"`
		DefaultBranchRef *struct {
			Target *struct {
				OID     string `json:"oid"`
				History struct {
					TotalCount int               `json:"totalCount"`
					Nodes      []firstCommitNode `json:"nodes"`
				} `json:"history"`
			} `json:"target"`
		} `json:"defaultBranchRef"`
	} `json:"repository"`
}

// fetchDefaultBranchFirstCommit uses the same pinned-tip history cursor as TS.
// A missing repository/identity or a fork cannot establish attribution.
func (c *GitHubClient) fetchDefaultBranchFirstCommit(ctx context.Context, owner, name string) string {
	variables := map[string]any{"owner": owner, "name": name}
	var meta firstCommitResponse
	if c.graphql(ctx, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { isFork defaultBranchRef { target { ... on Commit { oid history(first: 1) { totalCount } } } } } }`, variables, &meta) != nil {
		return ""
	}
	r := meta.Repository
	if r == nil || r.IsFork || r.DefaultBranchRef == nil || r.DefaultBranchRef.Target == nil {
		return ""
	}
	target := r.DefaultBranchRef.Target
	if target.History.TotalCount <= 0 || target.OID == "" {
		return ""
	}
	variables["after"] = nil
	if target.History.TotalCount >= 2 {
		variables["after"] = fmt.Sprintf("%s %d", target.OID, target.History.TotalCount-2)
	}
	var history firstCommitResponse
	if c.graphql(ctx, `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit { history(first: 1, after: $after) { nodes { oid author { email user { login } } committer { email user { login } } } } } } } } }`, variables, &history) != nil {
		return ""
	}
	r = history.Repository
	if r == nil || r.DefaultBranchRef == nil || r.DefaultBranchRef.Target == nil || len(r.DefaultBranchRef.Target.History.Nodes) == 0 {
		return ""
	}
	commit := r.DefaultBranchRef.Target.History.Nodes[0]
	actor := func(a *firstCommitActor) (string, string) {
		if a == nil {
			return "", ""
		}
		if a.User == nil {
			return "", a.Email
		}
		return a.User.Login, a.Email
	}
	author, authorEmail := actor(commit.Author)
	committer, committerEmail := actor(commit.Committer)
	if author == "" && commit.OID != "" {
		var rest struct {
			Author *struct {
				Login string `json:"login"`
			} `json:"author"`
		}
		if c.restGet(ctx, "repos/"+owner+"/"+name+"/commits/"+commit.OID, &rest) == nil && rest.Author != nil {
			author = rest.Author.Login
		}
	}
	return resolveFirstCommitLogin(author, committer, authorEmail, committerEmail)
}
