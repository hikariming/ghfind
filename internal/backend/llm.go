package backend

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultStepFunBaseURL  = "https://api.stepfun.com/v1"
	defaultStepFunModel    = "step-3.7-flash"
	defaultOpenRouterURL   = "https://openrouter.ai/api/v1"
	defaultOpenRouterModel = "deepseek/deepseek-chat-v3-0324:free"
	defaultFallbackURL     = "https://api.deepseek.com"
	defaultFallbackModel   = "deepseek-v4-flash"
)

type LLMConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

type LLMMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type LLMStreamEvent struct {
	Reasoning string
	Content   string
}

type LLMQuotaError struct {
	Status  int
	Message string
}

func (e *LLMQuotaError) Error() string { return e.Message }

func (c Config) DefaultLLMConfigs() []LLMConfig {
	configs := make([]LLMConfig, 0, 2)
	if c.LLMAPIKey != "" {
		base, model := c.LLMBaseURL, c.LLMModel
		if c.LLMLegacyOpenRouter {
			if base == "" {
				base = defaultOpenRouterURL
			}
			if model == "" {
				model = defaultOpenRouterModel
			}
		} else {
			if base == "" {
				base = defaultStepFunBaseURL
			}
			if model == "" {
				model = defaultStepFunModel
			}
		}
		configs = append(configs, LLMConfig{BaseURL: base, APIKey: c.LLMAPIKey, Model: model})
	}
	if c.LLMFallbackAPIKey != "" {
		base, model := c.LLMFallbackBaseURL, c.LLMFallbackModel
		if base == "" {
			base = defaultFallbackURL
		}
		if model == "" {
			model = defaultFallbackModel
		}
		configs = append(configs, LLMConfig{BaseURL: base, APIKey: c.LLMFallbackAPIKey, Model: model})
	}
	return configs
}

func validLLMConfig(config LLMConfig) bool {
	if strings.TrimSpace(config.APIKey) == "" || strings.TrimSpace(config.Model) == "" {
		return false
	}
	parsed, err := http.NewRequest(http.MethodGet, strings.TrimRight(config.BaseURL, "/")+"/", nil)
	return err == nil && (parsed.URL.Scheme == "https" || parsed.URL.Scheme == "http")
}

// CompleteLLM calls the OpenAI-compatible non-streaming chat endpoint. It only
// fails over before a response is accepted, which is equivalent to the old
// verdict path that accumulated a stream before parsing it.
func CompleteLLM(ctx context.Context, client *http.Client, configs []LLMConfig, messages []LLMMessage, temperature float64, deadline time.Time) (string, error) {
	if client == nil {
		client = &http.Client{Timeout: 100 * time.Second}
	}
	var lastErr error
	for _, config := range configs {
		if !validLLMConfig(config) {
			continue
		}
		requestCtx := ctx
		var cancel context.CancelFunc
		if !deadline.IsZero() {
			requestCtx, cancel = context.WithDeadline(ctx, deadline)
		}
		text, err := completeLLMOnce(requestCtx, client, config, messages, temperature)
		deadlineErr := requestCtx.Err()
		if cancel != nil {
			cancel()
		}
		if err == nil {
			return text, nil
		}
		lastErr = err
		if errors.Is(deadlineErr, context.DeadlineExceeded) {
			lastErr = fmt.Errorf("LLM timed out: %w", deadlineErr)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no LLM configuration")
	}
	return "", lastErr
}

// StreamLLM preserves OpenAI-compatible SSE output for the roast endpoint.
// It retries a fallback provider only if no user-visible content has been
// emitted, so a partially streamed report is never duplicated mid-response.
func StreamLLM(ctx context.Context, client *http.Client, configs []LLMConfig, messages []LLMMessage, temperature float64, deadline time.Time, attemptBudget time.Duration, emit func(LLMStreamEvent) error) error {
	if client == nil {
		client = &http.Client{}
	}
	var lastErr error
	for _, config := range configs {
		if !validLLMConfig(config) {
			continue
		}
		attemptDeadline := deadline
		if attemptBudget > 0 {
			candidate := time.Now().Add(attemptBudget)
			if attemptDeadline.IsZero() || candidate.Before(attemptDeadline) {
				attemptDeadline = candidate
			}
		}
		attemptCtx := ctx
		var cancel context.CancelFunc
		if !attemptDeadline.IsZero() {
			attemptCtx, cancel = context.WithDeadline(ctx, attemptDeadline)
		}
		emittedContent, err := streamLLMOnce(attemptCtx, client, config, messages, temperature, emit)
		deadlineErr := attemptCtx.Err()
		if cancel != nil {
			cancel()
		}
		if err == nil {
			return nil
		}
		lastErr = err
		if errors.Is(deadlineErr, context.DeadlineExceeded) {
			lastErr = fmt.Errorf("LLM timed out: %w", deadlineErr)
		}
		if emittedContent {
			return lastErr
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no LLM configuration")
	}
	return lastErr
}

func streamLLMOnce(ctx context.Context, client *http.Client, config LLMConfig, messages []LLMMessage, temperature float64, emit func(LLMStreamEvent) error) (bool, error) {
	payload := map[string]any{"model": config.Model, "messages": messages, "stream": true, "temperature": temperature}
	if isStepFunLLMEndpoint(config.BaseURL) {
		payload["reasoning_effort"] = "low"
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(config.BaseURL, "/")+"/chat/completions", bytes.NewReader(encoded))
	if err != nil {
		return false, fmt.Errorf("create LLM stream request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+config.APIKey)
	request.Header.Set("HTTP-Referer", "https://ghfind.com")
	request.Header.Set("X-Title", "GitHub Roast")
	response, err := client.Do(request)
	if err != nil {
		return false, fmt.Errorf("LLM stream request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusPaymentRequired || response.StatusCode == http.StatusTooManyRequests {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
		return false, &LLMQuotaError{Status: response.StatusCode, Message: truncateLLMError(body, response.StatusCode)}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2<<20))
		return false, errors.New(truncateLLMError(body, response.StatusCode))
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 16<<10), 2<<20)
	emittedContent := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			return emittedContent, nil
		}
		var event struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					Reasoning        string `json:"reasoning"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil || len(event.Choices) == 0 {
			continue
		}
		value := LLMStreamEvent{Reasoning: event.Choices[0].Delta.ReasoningContent, Content: event.Choices[0].Delta.Content}
		if value.Reasoning == "" {
			value.Reasoning = event.Choices[0].Delta.Reasoning
		}
		if value.Content == "" && value.Reasoning == "" {
			continue
		}
		if value.Content != "" {
			emittedContent = true
		}
		if emit != nil {
			if err := emit(value); err != nil {
				return emittedContent, err
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return emittedContent, fmt.Errorf("read LLM stream: %w", err)
	}
	return emittedContent, nil
}

func isStepFunLLMEndpoint(baseURL string) bool {
	request, err := http.NewRequest(http.MethodGet, strings.TrimRight(baseURL, "/")+"/", nil)
	if err != nil {
		return false
	}
	hostname := strings.ToLower(request.URL.Hostname())
	return hostname == "stepfun.com" || strings.HasSuffix(hostname, ".stepfun.com")
}

func completeLLMOnce(ctx context.Context, client *http.Client, config LLMConfig, messages []LLMMessage, temperature float64) (string, error) {
	payload, err := json.Marshal(map[string]any{"model": config.Model, "messages": messages, "stream": false, "temperature": temperature})
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(config.BaseURL, "/")+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("create LLM request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+config.APIKey)
	request.Header.Set("HTTP-Referer", "https://ghfind.com")
	request.Header.Set("X-Title", "GitHub Roast")
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("LLM request failed: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		return "", fmt.Errorf("read LLM response: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusPaymentRequired || response.StatusCode == http.StatusTooManyRequests {
		return "", &LLMQuotaError{Status: response.StatusCode, Message: truncateLLMError(body, response.StatusCode)}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", errors.New(truncateLLMError(body, response.StatusCode))
	}
	var decoded struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return "", fmt.Errorf("decode LLM response: %w", err)
	}
	if len(decoded.Choices) == 0 {
		return "", errors.New("LLM response had no choices")
	}
	return decoded.Choices[0].Message.Content, nil
}

func truncateLLMError(body []byte, status int) string {
	text := strings.TrimSpace(string(body))
	if len([]rune(text)) > 300 {
		text = string([]rune(text)[:300])
	}
	if text == "" {
		text = fmt.Sprintf("LLM error %d", status)
	}
	return text
}
