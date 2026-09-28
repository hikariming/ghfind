package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hikariming/ghfind/internal/backend"
)

func TestCapacityS3FailureRequiresObservedErasure(t *testing.T) {
	const bucket = "capacity-test"
	const key = "feed/v1/users/900000001/1/capacity-event-summary.json"
	outage := newCapacityS3Outage(bucket, key)
	defer outage.server.Close()
	rep := &report{Deletion: map[string]any{"s3FailureObserved": false}}
	if err := outage.recordFailure(rep, errors.New("database unavailable")); err == nil || rep.Deletion["s3FailureObserved"] != false {
		t.Fatal("an unrelated pre-S3 error supplied false injection evidence")
	}
	// A request to the fault server is not sufficient unless it is the specific
	// archive erasure. In particular bucket setup and wrong keys cannot count.
	for _, shape := range []struct{ method, path, body, state string }{
		{http.MethodHead, "/" + bucket, "", ""},
		{http.MethodPut, "/" + bucket + "/wrong-key", "", "erased"},
		{http.MethodPut, "/" + bucket + "/" + key, "private contents", "erased"},
		{http.MethodPut, "/" + bucket + "/" + key, "", "archive"},
	} {
		req, _ := http.NewRequest(shape.method, outage.server.URL+shape.path, strings.NewReader(shape.body))
		req.Header.Set("X-Amz-Meta-Feed-State", shape.state)
		resp, err := outage.server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest || outage.requests.Load() != 0 {
			t.Fatal("a non-erasure request supplied false injection evidence")
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	objects, err := backend.NewFeedS3Objects(ctx, backend.FeedS3Config{
		Endpoint: outage.server.URL, Region: "us-east-1", Bucket: bucket,
		AccessKeyID: "capacity-test-only", SecretAccessKey: "capacity-test-only-secret", UsePathStyle: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	eraseErr := objects.Erase(ctx, key)
	if eraseErr == nil || !strings.Contains(eraseErr.Error(), capacityS3FailureCode) {
		t.Fatalf("real S3 client did not return the injected HTTP fault: %v", eraseErr)
	}
	if err := outage.recordFailure(rep, eraseErr); err != nil {
		t.Fatal(err)
	}
	requests, ok := rep.Deletion["s3FailureRequests"].(int64)
	if !ok || requests < 1 || requests > 2 || rep.Deletion["s3FailureObserved"] != true || rep.Deletion["s3FailureCode"] != capacityS3FailureCode {
		t.Fatalf("unexpected observed injection evidence: %#v", rep.Deletion)
	}
	// Even an observed endpoint call cannot make a successful cleanup count as
	// a failed S3 operation.
	if err := outage.recordFailure(&report{Deletion: map[string]any{}}, nil); err == nil {
		t.Fatal("successful operation supplied false injection evidence")
	}
}
