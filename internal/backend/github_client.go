package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const defaultGitHubAPIURL = "https://api.github.com"

var (
	ErrGitHubAccountNotFound = errors.New("GitHub account not found")
	ErrGitHubRateLimited     = errors.New("GitHub rate limited")
	ErrGitHubAuthRequired    = errors.New("GITHUB_TOKEN is required")
	ErrGitHubUnavailable     = errors.New("GitHub data unavailable")
	ErrGitHubResourceLimit   = errors.New("GitHub GraphQL resource limit")
)

// GitHubClient executes the same authenticated REST/GraphQL collection calls
// as the former Next implementation. It owns token rotation in the Go worker;
// no token is ever sent to Next or a browser.
type GitHubClient struct {
	baseURL    string
	httpClient *http.Client
	tokens     []string
	nextToken  atomic.Uint64
}

// ParseGitHubTokens splits the comma-separated GITHUB_TOKEN pool, dropping
// blanks. One token works alone; N tokens are all recognized and rotated.
func ParseGitHubTokens(rawTokens string) []string {
	tokens := []string{}
	for _, token := range strings.Split(rawTokens, ",") {
		if token = strings.TrimSpace(token); token != "" {
			tokens = append(tokens, token)
		}
	}
	return tokens
}

func NewGitHubClient(rawTokens string) *GitHubClient {
	return &GitHubClient{
		baseURL:    defaultGitHubAPIURL,
		httpClient: &http.Client{Timeout: 25 * time.Second},
		tokens:     ParseGitHubTokens(rawTokens),
	}
}

func (c *GitHubClient) withHTTPClient(client *http.Client) *GitHubClient {
	c.httpClient = client
	return c
}

func (c *GitHubClient) withBaseURL(baseURL string) *GitHubClient {
	c.baseURL = strings.TrimRight(baseURL, "/")
	return c
}

func (c *GitHubClient) HasToken() bool { return len(c.tokens) > 0 }

func (c *GitHubClient) request(ctx context.Context, method, endpoint string, body []byte, extra http.Header) (*http.Response, error) {
	if c.httpClient == nil {
		c.httpClient = &http.Client{Timeout: 25 * time.Second}
	}
	// Retry budget: rotate through up to 4 pool tokens per request, but never
	// below 2 attempts — a single-token pool still deserves one same-token
	// retry, because GitHub 502s are usually gone after a short backoff.
	attempts := 2
	if count := len(c.tokens); count > 2 {
		attempts = count
		if attempts > 4 {
			attempts = 4
		}
	}
	base := c.nextToken.Add(1) - 1
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		request, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("create GitHub request: %w", err)
		}
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		request.Header.Set("User-Agent", "ghfind")
		for key, values := range extra {
			request.Header.Del(key)
			for _, value := range values {
				request.Header.Add(key, value)
			}
		}
		if len(c.tokens) > 0 {
			request.Header.Set("Authorization", "Bearer "+c.tokens[(base+uint64(attempt))%uint64(len(c.tokens))])
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			lastErr = err
			if attempt+1 < attempts && !waitGitHubRetry(ctx, 250*time.Millisecond, 0) {
				break
			}
			continue
		}
		if retryableGitHubResponse(response) && attempt+1 < attempts {
			retryAfter, _ := strconv.ParseFloat(response.Header.Get("Retry-After"), 64)
			_ = response.Body.Close()
			wait := 250 * time.Millisecond
			if retryAfter > 0 {
				wait = time.Duration(retryAfter * float64(time.Second))
				if wait > 2*time.Second {
					wait = 2 * time.Second
				}
			} else if attempt == 1 {
				wait = 500 * time.Millisecond
			}
			if !waitGitHubRetry(ctx, wait, 0) {
				return nil, ctx.Err()
			}
			continue
		}
		return response, nil
	}
	if lastErr == nil {
		lastErr = ErrGitHubUnavailable
	}
	return nil, fmt.Errorf("GitHub request failed: %w", lastErr)
}

func retryableGitHubResponse(response *http.Response) bool {
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusUnauthorized || response.StatusCode >= 500 {
		return true
	}
	return response.StatusCode == http.StatusForbidden && (response.Header.Get("X-Ratelimit-Remaining") == "0" || response.Header.Get("Retry-After") != "")
}

func waitGitHubRetry(ctx context.Context, wait, _ time.Duration) bool {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (c *GitHubClient) restGet(ctx context.Context, path string, out any) error {
	response, err := c.request(ctx, http.MethodGet, c.baseURL+"/"+strings.TrimLeft(path, "/"), nil, nil)
	if err != nil {
		return fmt.Errorf("GitHub REST %s: %w", path, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNotFound:
		return ErrGitHubAccountNotFound
	case http.StatusForbidden, http.StatusTooManyRequests:
		if response.StatusCode == http.StatusTooManyRequests || response.Header.Get("X-Ratelimit-Remaining") == "0" {
			return ErrGitHubRateLimited
		}
		return fmt.Errorf("GitHub REST %s: %w", path, ErrGitHubUnavailable)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("GitHub REST %s: HTTP %d: %w", path, response.StatusCode, ErrGitHubUnavailable)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 12<<20))
	if err := decoder.Decode(out); err != nil {
		return fmt.Errorf("decode GitHub REST %s: %w", path, err)
	}
	return nil
}

type graphQLError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
}

func (c *GitHubClient) graphql(ctx context.Context, query string, variables map[string]any, out any) error {
	if !c.HasToken() {
		return ErrGitHubAuthRequired
	}
	payload, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return fmt.Errorf("marshal GitHub GraphQL request: %w", err)
	}
	response, err := c.request(ctx, http.MethodPost, c.baseURL+"/graphql", payload, http.Header{"Content-Type": []string{"application/json"}})
	if err != nil {
		return fmt.Errorf("GitHub GraphQL request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusTooManyRequests {
		return ErrGitHubRateLimited
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("GitHub GraphQL HTTP %d: %w", response.StatusCode, ErrGitHubUnavailable)
	}
	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Errors []graphQLError  `json:"errors"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 12<<20)).Decode(&envelope); err != nil {
		return fmt.Errorf("decode GitHub GraphQL response: %w", err)
	}
	if len(envelope.Errors) > 0 {
		first := envelope.Errors[0]
		if first.Type == "RESOURCE_LIMITS_EXCEEDED" {
			return fmt.Errorf("%s: %w", first.Message, ErrGitHubResourceLimit)
		}
		if strings.Contains(strings.ToLower(first.Message), "rate") && strings.Contains(strings.ToLower(first.Message), "limit") {
			return fmt.Errorf("%s: %w", first.Message, ErrGitHubRateLimited)
		}
		return fmt.Errorf("%s: %w", first.Message, ErrGitHubUnavailable)
	}
	if len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return ErrGitHubUnavailable
	}
	if err := json.Unmarshal(envelope.Data, out); err != nil {
		return fmt.Errorf("decode GitHub GraphQL data: %w", err)
	}
	return nil
}

type githubUser struct {
	Login       string  `json:"login"`
	ID          float64 `json:"id"`
	HTMLURL     *string `json:"html_url"`
	AvatarURL   *string `json:"avatar_url"`
	Name        *string `json:"name"`
	Bio         *string `json:"bio"`
	Company     *string `json:"company"`
	CreatedAt   *string `json:"created_at"`
	Followers   float64 `json:"followers"`
	Following   float64 `json:"following"`
	PublicRepos float64 `json:"public_repos"`
}

type githubRepo struct {
	Name            string  `json:"name"`
	FullName        string  `json:"full_name"`
	Private         bool    `json:"private"`
	Fork            bool    `json:"fork"`
	Size            float64 `json:"size"`
	StargazersCount float64 `json:"stargazers_count"`
	ForksCount      float64 `json:"forks_count"`
	OpenIssuesCount float64 `json:"open_issues_count"`
	Language        *string `json:"language"`
	Description     *string `json:"description"`
	PushedAt        *string `json:"pushed_at"`
	Owner           *struct {
		Login string `json:"login"`
	} `json:"owner"`
	Topics []string `json:"topics"`
}

func (c *GitHubClient) GetUser(ctx context.Context, username string) (githubUser, error) {
	var user githubUser
	err := c.restGet(ctx, "users/"+url.PathEscape(username), &user)
	return user, err
}

func (c *GitHubClient) ListUserRepos(ctx context.Context, username string, page int) ([]githubRepo, error) {
	var repos []githubRepo
	path := "users/" + url.PathEscape(username) + "/repos?per_page=100&sort=pushed&page=" + strconv.Itoa(maxInt(page, 1))
	err := c.restGet(ctx, path, &repos)
	return repos, err
}

func (c *GitHubClient) LatestPublicActivity(ctx context.Context, username string) (*time.Time, error) {
	var events []struct {
		CreatedAt *string `json:"created_at"`
	}
	if err := c.restGet(ctx, "users/"+url.PathEscape(username)+"/events/public?per_page=30", &events); err != nil {
		return nil, err
	}
	var latest *time.Time
	for _, event := range events {
		parsed, ok := parseTimestamp(event.CreatedAt)
		if ok && (latest == nil || parsed.After(*latest)) {
			copy := parsed
			latest = &copy
		}
	}
	return latest, nil
}
