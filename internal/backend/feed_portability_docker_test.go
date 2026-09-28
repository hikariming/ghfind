//go:build feedportability

package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	feedauth "github.com/hikariming/ghfind/internal/feed/auth"
)

// Explicit integration entry: never skipped, never resets a database, and never
// starts an in-process API. The external Docker API is the only HTTP transport.
func TestFeedDockerHTTPPortability(t *testing.T) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), portabilityHTTPDeadline)
	defer cancel()
	c, err := readPortabilityConfig(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	report, err := os.OpenFile(c.Report, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal("fresh report required")
	}
	defer report.Close()
	result := map[string]any{"format": "ghfind-docker-http-contract-v1", "sourceSha": c.SHA, "harnessBuildSha": portabilityBuildSHA, "fixtureOwner": c.Owner, "startedAt": started.UTC(), "status": "incomplete", "limits": map[string]int{"httpRequests": 100, "seconds": 120, "projects": 50}, "scope": "ordinary Docker API, synthetic signed gateway identities and direct synthetic projections; no GitHub OAuth, real assessment, source queue, completed deletion cleanup, S3 recovery, Cloudflare or capacity acceptance"}
	write := func() {
		if _, err := report.Seek(0, 0); err != nil {
			t.Error("report seek failed")
			return
		}
		if err := report.Truncate(0); err != nil {
			t.Error("report truncate failed")
			return
		}
		if err := json.NewEncoder(report).Encode(result); err != nil {
			t.Error("report write failed")
		}
	}
	write()
	endpoint, _ := url.Parse(c.Endpoint)
	tr := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext, ResponseHeaderTimeout: 5 * time.Second, MaxResponseHeaderBytes: 16 << 10}
	defer tr.CloseIdleConnections()
	httpRun := &portabilityHTTP{ctx: ctx, endpoint: endpoint, client: &http.Client{Transport: tr, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	defer func() {
		result["finishedAt"] = time.Now().UTC()
		result["durationSeconds"] = time.Since(started).Seconds()
		result["httpCalls"] = httpRun.calls
		result["observations"] = httpRun.observations
		if ctx.Err() != nil {
			t.Error("portability deadline exhausted before report completion")
		}
		if !t.Failed() && ctx.Err() == nil {
			result["status"] = "passed"
		}
		write()
	}()
	if portabilityBuildSHA != c.SHA {
		t.Fatal("harness binary does not match exact source SHA")
	}
	if err := verifyPortabilityDocker(ctx, c); err != nil {
		t.Fatal(err)
	}
	result["dockerEndpointOwnershipVerified"] = true
	store, err := OpenPostgresFeedStore(Config{FeedDatabaseURL: c.DSN})
	if err != nil {
		t.Fatal("fixture store could not be opened")
	}
	defer store.Close()
	// Ownership is checked before any database write. There is intentionally no
	// migration/reset fallback when the marker or expected empty facts are absent.
	var owner, source, version string
	var port int
	var claimed bool
	err = store.db.QueryRowContext(ctx, `SELECT owner_id::text,source_sha,fixture_version,api_port,claimed FROM public.feed_portability_fixture WHERE singleton=true`).Scan(&owner, &source, &version, &port, &claimed)
	if err != nil || owner != c.Owner || source != c.SHA || version != portabilityFixtureVersion || port != c.APIPort || claimed {
		t.Fatal("fresh ownership marker mismatch")
	}
	rows, err := store.db.QueryContext(ctx, `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='feed' ORDER BY tablename`)
	if err != nil {
		t.Fatal("fixture table inventory unavailable")
	}
	tables := []string{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatal("table inventory invalid")
		}
		tables = append(tables, name)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(tables) == 0 {
		t.Fatal("fixture schema missing")
	}
	for _, table := range tables {
		query, want, err := portabilityEmptyTableQuery(table)
		if err != nil {
			t.Fatal(err)
		}
		var count int
		if store.db.QueryRowContext(ctx, query).Scan(&count) != nil || count != want {
			t.Fatalf("fixture table %s has unexpected facts; reset forbidden", table)
		}
	}
	result["emptyBusinessTableCount"] = len(tables)
	claimedResult, err := store.db.ExecContext(ctx, `UPDATE public.feed_portability_fixture SET claimed=true WHERE singleton=true AND owner_id=$1::uuid AND source_sha=$2 AND claimed=false`, c.Owner, c.SHA)
	if err != nil {
		t.Fatal("fixture ownership claim failed")
	}
	affected, err := claimedResult.RowsAffected()
	if err != nil || affected != 1 {
		t.Fatal("fixture already claimed")
	}
	if err := store.EnablePortableRuntime(1); err != nil {
		t.Fatal(err)
	}
	if err := store.Ping(ctx); err != nil {
		t.Fatal("fixture schema/contract not ready")
	}
	result["fixtureMarkerVerified"] = true
	call := func(actor int64, method, path string, input any, expected int, alter func(*http.Request)) []byte {
		t.Helper()
		var data []byte
		if input != nil {
			data, err = json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
		}
		r, err := http.NewRequestWithContext(ctx, method, path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Content-Type", "application/json")
		if actor > 0 {
			signer, _ := feedauth.New(strings.Repeat("g", 32), "feed-api")
			now := time.Now()
			token, e := signer.Sign(feedauth.Claims{Version: 1, Audience: "feed-api", GitHubID: actor, Login: "contract-user", IssuedAt: now.UnixMilli(), ExpiresAt: now.Add(30 * time.Second).UnixMilli(), Method: method, Target: r.URL.RequestURI(), BodySHA256: feedauth.BodyHash(data)})
			if e != nil {
				t.Fatal(e)
			}
			r.Header.Set(feedauth.Header, token)
		}
		if alter != nil {
			alter(r)
		}
		response, e := httpRun.do(r)
		if e != nil {
			t.Fatal("bounded HTTP transport failed")
		}
		defer response.Body.Close()
		if response.StatusCode != expected || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("HTTP %s %s: got %d want %d with no-store", method, r.URL.Path, response.StatusCode, expected)
		}
		var buf bytes.Buffer
		_, e = buf.ReadFrom(response.Body)
		if e != nil {
			t.Fatal("response failed")
		}
		return buf.Bytes()
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		var health map[string]any
		if json.Unmarshal(call(0, "GET", path, nil, 200, nil), &health) != nil {
			t.Fatal("bad health JSON")
		}
		if health["service"] != "feed-api" || health["version"] != c.SHA || health["contractVersion"] != "1" {
			t.Fatal("API build/contract mismatch")
		}
		if path == "/readyz" && (health["ready"] != true || health["storeProfile"] != "postgres" || health["writerEpoch"] != float64(1)) {
			t.Fatal("API is not ready on PostgreSQL epoch1")
		}
		if v, ok := health["storageWriterVersion"]; ok && v != float64(FeedStorageWriterVersion) {
			t.Fatal("API storage writer mismatch")
		}
		result[strings.TrimPrefix(path, "/")] = health
	}
	call(0, "GET", "/api/feed/projects", nil, 401, func(r *http.Request) { r.Header.Set("X-GitHub-Id", "4242"); r.Header.Set("X-Feed-GitHub-Id", "4242") })
	call(4242, "GET", "/api/feed/projects", nil, 401, func(r *http.Request) { r.Header.Set(feedauth.Header, "forged.invalid.signature") })
	contract := runPortableAPIContractWithTransport(t, ctx, store, httpRun.do)
	call(4243, "GET", "/api/feed/projects?limit=20&cursor="+url.QueryEscape(contract.FirstCursor), nil, 400, nil)
	call(4242, "GET", "/api/feed/projects?limit=20&cursor="+url.QueryEscape(contract.FirstCursor), nil, 410, nil)
	var page feedProjectsResponse
	if json.Unmarshal(call(4242, "GET", "/api/feed/projects?limit=20", nil, 200, nil), &page) != nil || len(page.Items) != 20 {
		t.Fatal("new generation could not create a full fresh page")
	}
	call(4242, "POST", "/api/feed/events", map[string]any{"events": []FeedEventInput{{ID: "33333333-3333-4333-8333-333333333333", Type: FeedEventImpression, RepoKey: contract.RepoKey, ImpressionToken: contract.ImpressionToken, OccurredAt: time.Now().UTC()}}}, 400, nil)
	var generation, floor int64
	var status string
	err = store.db.QueryRowContext(ctx, `SELECT u.profile_version,d.profile_version,d.cleanup_status FROM feed.users u JOIN feed.user_deletion_tombstones d ON d.github_id=u.github_id WHERE u.github_id=4242 AND d.deletion_id=$1`, contract.DeletionID).Scan(&generation, &floor, &status)
	if err != nil || floor < 1 || generation <= floor || status != "queued" {
		t.Fatal("deletion fence/new generation not persisted in owned DB")
	}
	var eventCount, projects, receipts int
	if err = store.db.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM feed.events WHERE id='22222222-2222-4222-8222-222222222222'),(SELECT COUNT(*) FROM feed.projects),(SELECT COUNT(*) FROM feed.project_submission_evidence)`).Scan(&eventCount, &projects, &receipts); err != nil || eventCount != 0 || projects != 50 || receipts != 50 {
		t.Fatal("HTTP dedup/project fixture facts mismatch")
	}
	if ctx.Err() != nil {
		t.Fatal("portability deadline exhausted")
	}
	result["checks"] = []string{"actual Docker HTTP build and readiness", "anonymous and forged identity rejected", "50 direct synthetic projections and receipts", "stable pagination with intervening impression", "rolling owner cap", "cross-user token/cursor rejected", "event idempotency acknowledged with accepted0/duplicate1", "deletion queued and cross-user status isolation", "old generation cursor/token invalid", "new generation full page"}
	result["facts"] = map[string]any{"projects": projects, "submissionReceipts": receipts, "outboundRowsAfterDeletion": eventCount, "eventDuplicateReceipt": contract.EventDuplicate, "deletedGeneration": floor, "recreatedGeneration": generation, "deletionCleanupStatus": status}
	t.Log(fmt.Sprintf("bounded Docker HTTP contract: %d calls; %d synthetic projects; cleanup remains %s", httpRun.calls, projects, status))
}
