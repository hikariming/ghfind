package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestFeedEmbeddingProviderValidatesDimensions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/embeddings" || request.Header.Get("Authorization") != "Bearer key" {
			t.Errorf("unexpected embedding request: %s auth=%q", request.URL.Path, request.Header.Get("Authorization"))
		}
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		if body["model"] != "embed-v1" || body["dimensions"] != float64(3) {
			t.Errorf("body=%#v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"index": 0, "embedding": []float64{1, 2, 3}}}})
	}))
	defer server.Close()
	provider, err := NewFeedEmbeddingProvider(Config{EmbeddingBaseURL: server.URL + "/v1", EmbeddingAPIKey: "key", EmbeddingModel: "embed-v1", EmbeddingDimensions: 3})
	if err != nil {
		t.Fatal(err)
	}
	vector, err := provider.Embed(context.Background(), "descriptor")
	if err != nil || !reflect.DeepEqual(vector, []float64{1, 2, 3}) {
		t.Fatalf("vector=%v err=%v", vector, err)
	}
}

func TestDescriptorHashAndPGVectorAreStable(t *testing.T) {
	if descriptorHash("same") != descriptorHash("same") || descriptorHash("same") == descriptorHash("different") {
		t.Fatal("descriptor hash is not stable")
	}
	if got := formatPGVector([]float64{1, -.25, .0001}); got != "[1,-0.25,0.0001]" {
		t.Fatalf("vector=%q", got)
	}
}
