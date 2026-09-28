package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type UpstashStatusStore struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewUpstashStatusStore(config Config) (*UpstashStatusStore, error) {
	if config.UpstashURL == "" || config.UpstashToken == "" {
		return nil, fmt.Errorf("Upstash URL and token are required")
	}
	return &UpstashStatusStore{
		baseURL: strings.TrimRight(config.UpstashURL, "/"),
		token:   config.UpstashToken,
		client:  &http.Client{Timeout: 5 * time.Second},
	}, nil
}

func (s *UpstashStatusStore) Ping(ctx context.Context) error {
	_, found, err := s.command(ctx, "PING")
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("Upstash PING returned no result")
	}
	return nil
}

// command uses Upstash's documented POST command-array format. Keeping this
// tiny client in-house avoids changing Redis deployment or introducing a TCP
// endpoint that the existing REST-only configuration does not expose.
func (s *UpstashStatusStore) command(ctx context.Context, command ...any) (json.RawMessage, bool, error) {
	body, err := json.Marshal(command)
	if err != nil {
		return nil, false, fmt.Errorf("marshal Upstash command: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL, bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("create Upstash request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("call Upstash: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, false, fmt.Errorf("read Upstash response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, false, fmt.Errorf("Upstash returned HTTP %d", response.StatusCode)
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, false, fmt.Errorf("decode Upstash response: %w", err)
	}
	if envelope.Error != "" {
		return nil, false, fmt.Errorf("Upstash command failed: %s", envelope.Error)
	}
	return envelope.Result, envelope.Result != nil, nil
}
