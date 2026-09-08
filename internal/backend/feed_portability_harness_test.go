package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Set by the reproducible test-binary build; a source environment variable alone
// cannot assert that the harness was compiled from that commit.
var portabilityBuildSHA = "unversioned"

const portabilityFixtureVersion = "ghfind-docker-http-v1"
const portabilityHTTPRequestLimit = 100
const portabilityHTTPDeadline = 120 * time.Second

type portabilityConfig struct {
	DSN, Endpoint, SHA, Owner, Report  string
	APIContainer, PGContainer, ImageID string
	APIPort                            int
}

func readPortabilityConfig(getenv func(string) string) (portabilityConfig, error) {
	c := portabilityConfig{DSN: getenv("FEED_PORTABILITY_DATABASE_URL"), Endpoint: getenv("FEED_PORTABILITY_API_ENDPOINT"), SHA: getenv("FEED_PORTABILITY_SOURCE_SHA"), Owner: getenv("FEED_PORTABILITY_OWNER"), Report: getenv("FEED_PORTABILITY_REPORT")}
	c.APIContainer = getenv("FEED_PORTABILITY_API_CONTAINER")
	c.PGContainer = getenv("FEED_PORTABILITY_PG_CONTAINER")
	c.ImageID = getenv("FEED_PORTABILITY_IMAGE_ID")
	fail := errors.New("explicit loopback owned fixture, exact source SHA, and absolute report path required")
	db, err := url.Parse(c.DSN)
	if err != nil || db.Scheme != "postgres" || db.User == nil || db.Fragment != "" || db.RawPath != "" || !regexp.MustCompile(`^/[a-z][a-z0-9_]*_test$`).MatchString(db.Path) || !portabilityLoopback(db.Hostname()) || db.Port() == "" {
		return c, fail
	}
	if _, err = strconv.ParseUint(db.Port(), 10, 16); err != nil || db.Port() == "0" {
		return c, fail
	}
	if _, ok := db.User.Password(); !ok {
		return c, fail
	}
	for k, v := range db.Query() {
		if len(v) != 1 || (k != "sslmode" && k != "connect_timeout") {
			return c, fail
		}
	}
	if db.Query().Get("sslmode") != "disable" || db.Query().Get("connect_timeout") != "3" {
		return c, fail
	}
	api, err := url.Parse(c.Endpoint)
	if err != nil || api.Scheme != "http" || api.User != nil || api.Path != "" || api.RawQuery != "" || api.Fragment != "" || !portabilityLoopback(api.Hostname()) {
		return c, fail
	}
	c.APIPort, err = strconv.Atoi(api.Port())
	if err != nil || c.APIPort < 1 || c.APIPort > 65535 {
		return c, fail
	}
	if !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(c.SHA) || !regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`).MatchString(c.Owner) || !filepath.IsAbs(c.Report) {
		return c, fail
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(c.APIContainer) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(c.PGContainer) || !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(c.ImageID) {
		return c, fail
	}
	return c, nil
}
func portabilityLoopback(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.String() == "127.0.0.1"
}

type portabilityObservation struct {
	Method     string  `json:"method"`
	Path       string  `json:"path"`
	Status     int     `json:"status"`
	DurationMS float64 `json:"durationMs"`
	Error      string  `json:"error,omitempty"`
}
type portabilityHTTP struct {
	ctx          context.Context
	endpoint     *url.URL
	client       *http.Client
	observations []portabilityObservation
	calls        int
}

func (p *portabilityHTTP) do(r *http.Request) (*http.Response, error) {
	if p.ctx.Err() != nil {
		return nil, errors.New("portability_deadline")
	}
	if p.calls >= portabilityHTTPRequestLimit {
		return nil, errors.New("portability_http_limit")
	}
	if !strings.HasPrefix(r.URL.Path, "/api/feed/") && r.URL.Path != "/healthz" && r.URL.Path != "/readyz" {
		return nil, errors.New("portability_path")
	}
	p.calls++
	at := time.Now()
	o := portabilityObservation{Method: r.Method, Path: r.URL.Path}
	defer func() {
		o.DurationMS = float64(time.Since(at).Microseconds()) / 1000
		p.observations = append(p.observations, o)
	}()
	ctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
	defer cancel()
	request := r.Clone(ctx)
	target := *r.URL
	target.Scheme = p.endpoint.Scheme
	target.Host = p.endpoint.Host
	target.User = nil
	request.URL = &target
	request.RequestURI = ""
	request.Host = p.endpoint.Host
	response, err := p.client.Do(request)
	if err != nil {
		o.Error = "transport_error"
		return nil, errors.New(o.Error)
	}
	defer response.Body.Close()
	o.Status = response.StatusCode
	data, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(data) > 2<<20 {
		o.Error = "response_read_or_size"
		return nil, errors.New(o.Error)
	}
	response.Body = io.NopCloser(bytes.NewReader(data))
	return response, nil
}

func TestPortabilityConfigRejectsUnsafeOrMissingInputs(t *testing.T) {
	good := map[string]string{"FEED_PORTABILITY_API_CONTAINER": strings.Repeat("a", 64), "FEED_PORTABILITY_PG_CONTAINER": strings.Repeat("b", 64), "FEED_PORTABILITY_IMAGE_ID": "sha256:" + strings.Repeat("c", 64), "FEED_PORTABILITY_DATABASE_URL": "postgres://synthetic:synthetic@127.0.0.1:55446/feed_portability_test?sslmode=disable&connect_timeout=3", "FEED_PORTABILITY_API_ENDPOINT": "http://127.0.0.1:58087", "FEED_PORTABILITY_SOURCE_SHA": strings.Repeat("a", 40), "FEED_PORTABILITY_OWNER": "11111111-1111-4111-8111-111111111111", "FEED_PORTABILITY_REPORT": "/tmp/fixture/contract.json"}
	get := func(k string) string { return good[k] }
	if _, err := readPortabilityConfig(get); err != nil {
		t.Fatal(err)
	}
	for key, value := range good {
		good[key] = ""
		if _, err := readPortabilityConfig(get); err == nil {
			t.Fatalf("missing %s accepted", key)
		}
		good[key] = value
	}
	for _, bad := range []string{"postgres://synthetic:x@example.com:5432/feed_test?sslmode=disable&connect_timeout=3", "postgres://synthetic:x@127.0.0.1:5432/production?sslmode=disable&connect_timeout=3", good["FEED_PORTABILITY_DATABASE_URL"] + "&host=example.com", good["FEED_PORTABILITY_DATABASE_URL"] + "&sslmode=disable", strings.Replace(good["FEED_PORTABILITY_DATABASE_URL"], "connect_timeout=3", "connect_timeout=300", 1)} {
		old := good["FEED_PORTABILITY_DATABASE_URL"]
		good["FEED_PORTABILITY_DATABASE_URL"] = bad
		if _, err := readPortabilityConfig(get); err == nil {
			t.Fatal("unsafe DSN accepted")
		}
		good["FEED_PORTABILITY_DATABASE_URL"] = old
	}
	for _, bad := range []string{"http://localhost:8080", "https://127.0.0.1:8080", "http://127.0.0.1:8080/path", "http://user@127.0.0.1:8080", "http://127.0.0.1:8080?target=production"} {
		old := good["FEED_PORTABILITY_API_ENDPOINT"]
		good["FEED_PORTABILITY_API_ENDPOINT"] = bad
		if _, err := readPortabilityConfig(get); err == nil {
			t.Fatal("unsafe endpoint accepted")
		}
		good["FEED_PORTABILITY_API_ENDPOINT"] = old
	}
}

type portabilityRoundTripper func(*http.Request) (*http.Response, error)

func (f portabilityRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestPortabilityHTTPBoundedBeforeNetwork(t *testing.T) {
	endpoint, _ := url.Parse("http://127.0.0.1:58087")
	n := 0
	p := &portabilityHTTP{ctx: context.Background(), endpoint: endpoint, client: &http.Client{Transport: portabilityRoundTripper(func(r *http.Request) (*http.Response, error) {
		n++
		if r.RequestURI != "" || r.URL.Host != endpoint.Host {
			t.Fatal("bad real-client request")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}}
	r, _ := http.NewRequest("GET", "/api/feed/projects", nil)
	for i := 0; i < 100; i++ {
		response, err := p.do(r)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
	}
	if _, err := p.do(r); err == nil || n != 100 {
		t.Fatal("request limit did not stop transport")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p.ctx = ctx
	p.calls = 0
	if _, err := p.do(r); err == nil || n != 100 {
		t.Fatal("deadline reached network")
	}
	encoded, _ := json.Marshal(p.observations)
	if bytes.Contains(encoded, []byte("githubId")) {
		t.Fatal("identity retained")
	}
}

type portabilityDeadlineBody struct{ ctx context.Context }

func (b portabilityDeadlineBody) Read([]byte) (int, error) { <-b.ctx.Done(); return 0, b.ctx.Err() }
func (b portabilityDeadlineBody) Close() error             { return nil }
func TestPortabilityHTTPBodyUsesSharedDeadlineAndSizeBound(t *testing.T) {
	endpoint, _ := url.Parse("http://127.0.0.1:58087")
	for _, oversized := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		p := &portabilityHTTP{ctx: ctx, endpoint: endpoint, client: &http.Client{Transport: portabilityRoundTripper(func(r *http.Request) (*http.Response, error) {
			var body io.ReadCloser = portabilityDeadlineBody{r.Context()}
			if oversized {
				body = io.NopCloser(strings.NewReader(strings.Repeat("x", (2<<20)+1)))
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: body}, nil
		})}}
		r, _ := http.NewRequest("GET", "/api/feed/projects", nil)
		if _, err := p.do(r); err == nil {
			t.Fatal("unbounded response accepted")
		}
		cancel()
		if len(p.observations) != 1 || p.observations[0].Error != "response_read_or_size" {
			t.Fatal("response failure not recorded")
		}
	}
}
