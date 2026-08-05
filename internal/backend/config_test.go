package backend

import (
	"os"
	"testing"
	"time"
)

func TestAPIRequiresJobAdmissionSecretButWorkerDoesNot(t *testing.T) {
	config := Config{
		TursoURL: "libsql://ghfind-test.turso.io", RabbitURL: "amqp://rabbitmq",
		UpstashURL: "https://upstash.example", UpstashToken: "token", GitHubToken: "token", MaxAttempts: 1,
	}
	if err := config.ValidateWorker(); err != nil {
		t.Fatalf("worker validation = %v", err)
	}
	if err := config.ValidateAPI(); err == nil {
		t.Fatal("API validation accepted missing ADMIN_SECRET")
	}
	config.AdminSecret = "secret"
	if err := config.ValidateAPI(); err != nil {
		t.Fatalf("API validation = %v", err)
	}
}

func TestLibSQLDSNKeepsRemoteURLTokenFree(t *testing.T) {
	config := Config{TursoURL: "libsql://ghfind-test.turso.io", TursoAuth: "secret token"}
	dsn, err := config.LibSQLDSN()
	if err != nil {
		t.Fatal(err)
	}
	want := "libsql://ghfind-test.turso.io"
	if dsn != want {
		t.Fatalf("DSN = %q, want %q", dsn, want)
	}
}

func TestLibSQLDSNLeavesLocalFileTokenFree(t *testing.T) {
	config := Config{TursoURL: "file:./local.db", TursoAuth: "must-not-appear"}
	dsn, err := config.LibSQLDSN()
	if err != nil {
		t.Fatal(err)
	}
	if dsn != "file:./local.db" {
		t.Fatalf("DSN = %q", dsn)
	}
}

func TestAPIRailwayPortFallback(t *testing.T) {
	t.Setenv("PORT", "4567")
	t.Setenv("GHFIND_API_LISTEN_ADDR", "")

	if got := LoadConfigFromEnv().APIListenAddr; got != ":4567" {
		t.Fatalf("APIListenAddr = %q, want Railway PORT fallback", got)
	}
}

func TestAPIListenAddrOverridesPortFallback(t *testing.T) {
	t.Setenv("PORT", "4567")
	t.Setenv("GHFIND_API_LISTEN_ADDR", "127.0.0.1:8088")

	if got := LoadConfigFromEnv().APIListenAddr; got != "127.0.0.1:8088" {
		t.Fatalf("APIListenAddr = %q, want explicit override", got)
	}
}

func TestAPIDefaultListenAddrWithoutRailwayPort(t *testing.T) {
	t.Setenv("GHFIND_API_LISTEN_ADDR", "")
	if err := os.Unsetenv("PORT"); err != nil {
		t.Fatal(err)
	}

	if got := LoadConfigFromEnv().APIListenAddr; got != defaultAPIListenAddr {
		t.Fatalf("APIListenAddr = %q, want default", got)
	}
}

func TestScanConcurrencyScalesWithTokenPool(t *testing.T) {
	t.Setenv("GHFIND_SCAN_WORKER_CONCURRENCY", "")
	cases := []struct {
		tokens string
		want   int
	}{
		{"", minScanConcurrency},
		{"solo", scanConcurrencyBase},
		{"t1,t2", scanConcurrencyBase + scanConcurrencyPerToken},
		{"t1,t2,, t3", scanConcurrencyBase + 2*scanConcurrencyPerToken},
		{"t1,t2,t3,t4", maxScanConcurrency},
		{"t1,t2,t3,t4,t5", maxScanConcurrency},
	}
	for _, tc := range cases {
		t.Setenv("GITHUB_TOKEN", tc.tokens)
		if got := LoadConfigFromEnv().ScanConcurrency; got != tc.want {
			t.Fatalf("tokens=%q ScanConcurrency = %d, want %d", tc.tokens, got, tc.want)
		}
	}
}

func TestScanConcurrencyExplicitOverrideWins(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "t1,t2,t3,t4,t5")
	t.Setenv("GHFIND_SCAN_WORKER_CONCURRENCY", "8")
	if got := LoadConfigFromEnv().ScanConcurrency; got != 8 {
		t.Fatalf("ScanConcurrency = %d, want explicit override 8", got)
	}
}

func TestProjectAnalysisConfigDefaultsAndClamps(t *testing.T) {
	for _, name := range []string{
		"MOSOO_API_BASE", "MOSOO_API_TOKEN", "MOSOO_PROJECT_AGENT_ID",
		"MOSOO_PROJECT_REQUEST_TIMEOUT_MS", "PROJECT_ANALYSIS_TIMEOUT_MS",
		"GHFIND_PROJECT_ANALYSIS_CONCURRENCY", "PROJECT_ANALYSIS_MAX_CONCURRENCY",
		"PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS", "PROJECT_ANALYSIS_CREATE_RETRY_BASE_MS",
		"PROJECT_ANALYSIS_RUNTIME_ALLOWLIST", "PROJECT_ANALYSIS_RECONCILE_SECRET", "CRON_SECRET",
	} {
		t.Setenv(name, "")
	}
	config := LoadConfigFromEnv()
	if config.MosooAPIBase != "https://try.mosoo.ai/api/v1" {
		t.Fatalf("MosooAPIBase = %q", config.MosooAPIBase)
	}
	if config.MosooRequestTimeout != 15*time.Second {
		t.Fatalf("MosooRequestTimeout = %v", config.MosooRequestTimeout)
	}
	if config.ProjectAnalysisTimeout != 15*time.Minute {
		t.Fatalf("ProjectAnalysisTimeout = %v", config.ProjectAnalysisTimeout)
	}
	if config.ProjectAnalysisConcurrency != 3 {
		t.Fatalf("ProjectAnalysisConcurrency = %d", config.ProjectAnalysisConcurrency)
	}
	if config.ProjectAnalysisCreateMaxAttempts != 3 {
		t.Fatalf("ProjectAnalysisCreateMaxAttempts = %d", config.ProjectAnalysisCreateMaxAttempts)
	}
	if config.ProjectAnalysisCreateRetryBase != 5*time.Second {
		t.Fatalf("ProjectAnalysisCreateRetryBase = %v", config.ProjectAnalysisCreateRetryBase)
	}
	if config.ProjectAnalysisCreateAttemptLease() != 20*time.Second {
		t.Fatalf("CreateAttemptLease = %v", config.ProjectAnalysisCreateAttemptLease())
	}
}

func TestProjectAnalysisConfigClampsAndExecutionMode(t *testing.T) {
	t.Setenv("MOSOO_API_BASE", "https://mosoo.example/api/v1/")
	t.Setenv("MOSOO_PROJECT_REQUEST_TIMEOUT_MS", "250")
	t.Setenv("PROJECT_ANALYSIS_TIMEOUT_MS", "1000")
	t.Setenv("GHFIND_PROJECT_ANALYSIS_CONCURRENCY", "99")
	t.Setenv("PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS", "99")
	t.Setenv("PROJECT_ANALYSIS_CREATE_RETRY_BASE_MS", "999999")
	t.Setenv("PROJECT_ANALYSIS_RUNTIME_ALLOWLIST", " Owner/Trusted , other/repo ,")
	config := LoadConfigFromEnv()
	if config.MosooAPIBase != "https://mosoo.example/api/v1" {
		t.Fatalf("MosooAPIBase = %q", config.MosooAPIBase)
	}
	if config.MosooRequestTimeout != 15*time.Second {
		t.Fatalf("MosooRequestTimeout = %v", config.MosooRequestTimeout)
	}
	if config.ProjectAnalysisTimeout != 15*time.Minute {
		t.Fatalf("ProjectAnalysisTimeout = %v", config.ProjectAnalysisTimeout)
	}
	if config.ProjectAnalysisConcurrency != 20 {
		t.Fatalf("ProjectAnalysisConcurrency = %d", config.ProjectAnalysisConcurrency)
	}
	if config.ProjectAnalysisCreateMaxAttempts != 10 {
		t.Fatalf("ProjectAnalysisCreateMaxAttempts = %d", config.ProjectAnalysisCreateMaxAttempts)
	}
	if config.ProjectAnalysisCreateRetryBase != time.Minute {
		t.Fatalf("ProjectAnalysisCreateRetryBase = %v", config.ProjectAnalysisCreateRetryBase)
	}
	if got := config.ProjectAnalysisExecutionMode("OWNER/TRUSTED"); got != "allowlisted_runtime" {
		t.Fatalf("execution mode = %q", got)
	}
	if got := config.ProjectAnalysisExecutionMode("owner/trusted-fork"); got != "source_only" {
		t.Fatalf("execution mode = %q", got)
	}
	if got := config.ProjectAnalysisExecutionMode("other/repo"); got != "allowlisted_runtime" {
		t.Fatalf("execution mode = %q", got)
	}
}
