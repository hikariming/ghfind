package backend

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCompleteLLMFallsBackBeforeAcceptingAResponse(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "temporary upstream failure", http.StatusBadGateway)
	}))
	defer primary.Close()
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer fallback-key" {
			t.Fatalf("authorization=%q", request.Header.Get("Authorization"))
		}
		if !strings.Contains(request.URL.Path, "/chat/completions") {
			t.Fatalf("path=%q", request.URL.Path)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"fallback answer"}}]}`))
	}))
	defer fallback.Close()
	answer, err := CompleteLLM(context.Background(), fallback.Client(), []LLMConfig{
		{BaseURL: primary.URL, APIKey: "primary-key", Model: "primary-model"},
		{BaseURL: fallback.URL, APIKey: "fallback-key", Model: "fallback-model"},
	}, []LLMMessage{{Role: "user", Content: "hello"}}, 0.5, time.Now().Add(time.Minute))
	if err != nil || answer != "fallback answer" {
		t.Fatalf("answer=%q err=%v", answer, err)
	}
}

func TestCompleteLLMExposesQuotaError(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "quota exhausted", http.StatusTooManyRequests)
	}))
	defer provider.Close()
	_, err := CompleteLLM(context.Background(), provider.Client(), []LLMConfig{{BaseURL: provider.URL, APIKey: "key", Model: "model"}}, nil, 0.5, time.Now().Add(time.Minute))
	var quota *LLMQuotaError
	if !errors.As(err, &quota) || quota.Status != http.StatusTooManyRequests {
		t.Fatalf("err=%#v", err)
	}
}

func TestStreamLLMFallsBackBeforeVisibleContentAndPreservesSSEOrder(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "temporary upstream failure", http.StatusBadGateway)
	}))
	defer primary.Close()
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"## report\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\" body\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer fallback.Close()
	events := []LLMStreamEvent{}
	err := StreamLLM(context.Background(), fallback.Client(), []LLMConfig{
		{BaseURL: primary.URL, APIKey: "primary", Model: "one"},
		{BaseURL: fallback.URL, APIKey: "fallback", Model: "two"},
	}, []LLMMessage{{Role: "user", Content: "hello"}}, 0.5, time.Now().Add(time.Minute), 20*time.Second, func(event LLMStreamEvent) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Content != "## report" || events[1].Content != " body" {
		t.Fatalf("events=%#v", events)
	}
}
