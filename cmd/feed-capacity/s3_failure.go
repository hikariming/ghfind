package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
)

const capacityS3FailureCode = "capacity_injected_s3_outage"

// This fault endpoint observes actual archive erasure HTTP traffic. Only the
// expected erasure request counts as an injected S3 failure; setup/probes and
// unrelated database failures cannot supply evidence for this assertion.
type capacityS3Outage struct {
	server   *httptest.Server
	requests atomic.Int64
}

func newCapacityS3Outage(bucket, key string) *capacityS3Outage {
	out := &capacityS3Outage{}
	out.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1))
		if err != nil || len(body) != 0 || r.Method != http.MethodPut || r.URL.Path != "/"+bucket+"/"+key || r.Header.Get("X-Amz-Meta-Feed-State") != "erased" {
			http.Error(w, "unexpected capacity S3 request", http.StatusBadRequest)
			return
		}
		out.requests.Add(1)
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `<Error><Code>ServiceUnavailable</Code><Message>`+capacityS3FailureCode+`</Message></Error>`)
	}))
	return out
}

func (out *capacityS3Outage) recordFailure(rep *report, err error) error {
	rep.Deletion["s3FailureRequests"] = out.requests.Load()
	var response interface{ HTTPStatusCode() int }
	if out.requests.Load() < 1 || !errors.As(err, &response) || response.HTTPStatusCode() != http.StatusServiceUnavailable {
		return errors.New("archive cleanup did not observe the injected S3 HTTP503")
	}
	rep.Deletion["s3FailureObserved"] = true
	rep.Deletion["s3FailureCode"] = capacityS3FailureCode
	return nil
}
