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
	"time"
)

type GorseUser struct {
	UserID  string         `json:"UserId"`
	Labels  map[string]any `json:"Labels"`
	Comment string         `json:"Comment"`
}

type GorseItem struct {
	ItemID     string         `json:"ItemId"`
	IsHidden   bool           `json:"IsHidden"`
	Categories []string       `json:"Categories"`
	Timestamp  time.Time      `json:"Timestamp"`
	Labels     map[string]any `json:"Labels"`
	Comment    string         `json:"Comment"`
}

type GorseFeedback struct {
	FeedbackType string    `json:"FeedbackType"`
	UserID       string    `json:"UserId"`
	ItemID       string    `json:"ItemId"`
	Value        float64   `json:"Value"`
	Timestamp    time.Time `json:"Timestamp"`
}

type FeedGorseClient interface {
	UpsertUser(context.Context, GorseUser) error
	UpsertItem(context.Context, GorseItem) error
	PutFeedback(context.Context, []GorseFeedback) error
	DeleteFeedback(context.Context, string, string, string) error
	DeleteUser(context.Context, string) error
	Recommend(context.Context, string, int) ([]string, error)
}

type GorseClient struct {
	baseURL string
	apiKey  string
	client  *http.Client
}

func NewGorseClient(config Config) (*GorseClient, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.GorseBaseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("valid GORSE_BASE_URL is required")
	}
	if strings.TrimSpace(config.GorseServerAPIKey) == "" {
		return nil, fmt.Errorf("GORSE_SERVER_API_KEY is required")
	}
	return &GorseClient{baseURL: baseURL, apiKey: config.GorseServerAPIKey, client: &http.Client{Timeout: 2 * time.Second}}, nil
}

func (c *GorseClient) WithTimeout(timeout time.Duration) *GorseClient {
	if timeout > 0 {
		c.client.Timeout = timeout
	}
	return c
}

func (c *GorseClient) UpsertUser(ctx context.Context, user GorseUser) error {
	if err := validateGorseID(user.UserID); err != nil {
		return err
	}
	patch := map[string]any{"Labels": user.Labels, "Comment": user.Comment}
	status, err := c.request(ctx, http.MethodPatch, "/api/user/"+url.PathEscape(user.UserID), patch, nil)
	if err == nil && status != http.StatusNotFound {
		return nil
	}
	if err != nil && status != http.StatusNotFound {
		return err
	}
	_, err = c.request(ctx, http.MethodPost, "/api/user", user, nil)
	return err
}

func (c *GorseClient) UpsertItem(ctx context.Context, item GorseItem) error {
	if err := validateGorseID(item.ItemID); err != nil {
		return err
	}
	patch := map[string]any{"IsHidden": item.IsHidden, "Categories": item.Categories,
		"Timestamp": item.Timestamp, "Labels": item.Labels, "Comment": item.Comment}
	status, err := c.request(ctx, http.MethodPatch, "/api/item/"+url.PathEscape(item.ItemID), patch, nil)
	if err == nil && status != http.StatusNotFound {
		return nil
	}
	if err != nil && status != http.StatusNotFound {
		return err
	}
	_, err = c.request(ctx, http.MethodPost, "/api/item", item, nil)
	return err
}

func (c *GorseClient) PutFeedback(ctx context.Context, feedback []GorseFeedback) error {
	if len(feedback) == 0 {
		return nil
	}
	for _, item := range feedback {
		if err := validateGorseID(item.UserID); err != nil {
			return err
		}
		if err := validateGorseID(item.ItemID); err != nil {
			return err
		}
		if strings.TrimSpace(item.FeedbackType) == "" {
			return fmt.Errorf("Gorse feedback type is required")
		}
	}
	_, err := c.request(ctx, http.MethodPut, "/api/feedback", feedback, nil)
	return err
}

// DeleteFeedback mirrors Gorse's three-part feedback identity. This is
// required for unsave/undo-not-interested: writing a zero-valued replacement
// would still leave a feedback row that Gorse can learn from.
func (c *GorseClient) DeleteFeedback(ctx context.Context, feedbackType, userID, itemID string) error {
	if strings.TrimSpace(feedbackType) == "" {
		return fmt.Errorf("Gorse feedback type is required")
	}
	if err := validateGorseID(userID); err != nil {
		return err
	}
	if err := validateGorseID(itemID); err != nil {
		return err
	}
	path := "/api/feedback/" + url.PathEscape(feedbackType) + "/" + url.PathEscape(userID) + "/" + url.PathEscape(itemID)
	status, err := c.request(ctx, http.MethodDelete, path, nil, nil)
	if status == http.StatusNotFound {
		return nil
	}
	return err
}

func (c *GorseClient) DeleteUser(ctx context.Context, userID string) error {
	if err := validateGorseID(userID); err != nil {
		return err
	}
	status, err := c.request(ctx, http.MethodDelete, "/api/user/"+url.PathEscape(userID), nil, nil)
	if status == http.StatusNotFound {
		return nil
	}
	return err
}

func (c *GorseClient) Recommend(ctx context.Context, userID string, limit int) ([]string, error) {
	if err := validateGorseID(userID); err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	result := []string{}
	_, err := c.request(ctx, http.MethodGet, "/api/recommend/"+url.PathEscape(userID)+"?n="+strconv.Itoa(limit), nil, &result)
	return result, err
}

func (c *GorseClient) request(ctx context.Context, method, path string, body, target any) (int, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return 0, err
	}
	request.Header.Set("X-API-Key", c.apiKey)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("call Gorse %s %s: %w", method, path, err)
	}
	defer response.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if readErr != nil {
		return response.StatusCode, readErr
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusNotFound {
			return response.StatusCode, errors.New("Gorse record not found")
		}
		return response.StatusCode, fmt.Errorf("Gorse %s %s returned HTTP %d: %s", method, path, response.StatusCode, strings.TrimSpace(string(data)))
	}
	if target != nil && len(data) > 0 {
		if err := json.Unmarshal(data, target); err != nil {
			return response.StatusCode, fmt.Errorf("decode Gorse response: %w", err)
		}
	}
	return response.StatusCode, nil
}

func validateGorseID(id string) error {
	id = strings.TrimSpace(id)
	if id == "" || strings.Contains(id, "/") || len(id) > 256 {
		return fmt.Errorf("invalid Gorse id %q", id)
	}
	return nil
}

func FeedGorseUserID(githubID int64) string { return "gh:" + strconv.FormatInt(githubID, 10) }

func FeedGorseItem(project FeedProject, embedding []float64) GorseItem {
	tags := make([]string, 0, len(project.Tags))
	for _, tag := range project.Tags {
		tags = append(tags, tag.ID)
	}
	labels := map[string]any{
		"tags": uniqueStrings(tags), "embedding": embedding, "project_type": project.ProjectType,
		"lifecycle": project.Lifecycle, "language": project.Language, "product_score": project.ProductScore,
		"confidence": project.Confidence, "exposure_band": project.ExposureBand,
	}
	return GorseItem{ItemID: project.ItemID, IsHidden: !project.Publishable,
		Categories: uniqueStrings([]string{project.ProjectType, project.Lifecycle}), Timestamp: project.AnalyzedAt,
		Labels: labels, Comment: project.RepoKey}
}

var _ FeedGorseClient = (*GorseClient)(nil)
