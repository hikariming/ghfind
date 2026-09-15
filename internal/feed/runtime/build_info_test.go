package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hikariming/ghfind/internal/backend"
)

func TestBuildIdentityIsProcessSpecificAndNotEnvironmentSupplied(t *testing.T) {
	t.Setenv("IMAGE_BUILD_ID", strings.Repeat("f", 64))
	t.Setenv("FEED_IMAGE_BUILD_ID", strings.Repeat("f", 64))
	for _, service := range []string{"feed-api", "feed-worker"} {
		for _, compiled := range []string{strings.Repeat("a", 64), strings.Repeat("b", 64)} {
			var info bytes.Buffer
			if err := WriteBuildInfo(&info, service, "same-source-sha", compiled); err != nil {
				t.Fatal(err)
			}
			var fields map[string]any
			if err := json.Unmarshal(info.Bytes(), &fields); err != nil {
				t.Fatal(err)
			}
			if len(fields) != 3 || fields["service"] != service || fields["version"] != "same-source-sha" || fields["imageBuildId"] != compiled {
				t.Fatalf("build identity changed or leaked fields: %v", fields)
			}
			for _, failed := range []bool{false, true} {
				handler := WithHealth(http.NotFoundHandler(), Config{ImageBuildID: compiled, Mode: backend.FeedModeOff, StoreProfile: "cf_d1_r2", WriterEpoch: 1}, "same-source-sha", service, func(context.Context) error {
					if failed {
						return errors.New("private dependency error")
					}
					return nil
				})
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil))
				var ready map[string]any
				if err := json.Unmarshal(response.Body.Bytes(), &ready); err != nil {
					t.Fatal(err)
				}
				wantStatus := 200
				if failed {
					wantStatus = 503
				}
				if response.Code != wantStatus || ready["imageBuildId"] != compiled || ready["version"] != "same-source-sha" {
					t.Fatalf("readiness must retain real process build identity: %v", ready)
				}
				if strings.Contains(response.Body.String(), "private dependency") {
					t.Fatal("readiness leaked a dependency error")
				}
			}
		}
	}
}

func TestLoadConfigDoesNotReadExpectedImageBuildID(t *testing.T) {
	t.Setenv("FEED_MODE", "off")
	t.Setenv("FEED_STORE_PROFILE", "postgres")
	t.Setenv("FEED_GATEWAY_SECRET", strings.Repeat("g", 32))
	t.Setenv("FEED_SIGNING_SECRET", strings.Repeat("s", 32))
	t.Setenv("FEED_IMAGE_BUILD_ID", strings.Repeat("a", 64))
	t.Setenv("IMAGE_BUILD_ID", strings.Repeat("b", 64))
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.ImageBuildID != "" {
		t.Fatal("runtime config must not accept environment-supplied build identity")
	}
}
