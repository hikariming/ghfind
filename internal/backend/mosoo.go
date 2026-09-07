package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// This file mirrors src/lib/mosoo-project-analysis.ts: the Mosoo Public
// Thread API client used by the project analysis worker. The TypeScript
// module remains the source of truth for request shapes, error codes, and
// the public activity classification.

const (
	MosooUnavailable      = "mosoo_unavailable"
	MosooUnauthenticated  = "mosoo_unauthenticated"
	MosooForbidden        = "mosoo_forbidden"
	MosooNotReady         = "mosoo_not_ready"
	MosooRateLimited      = "mosoo_rate_limited"
	MosooInvalidResponse  = "mosoo_invalid_response"
	MosooArtifactMissing  = "artifact_missing"
	MosooExecutionSource  = "source_only"
	MosooExecutionRuntime = "allowlisted_runtime"
)

// MosooError carries the same public error codes as MosooProjectAnalysisError.
// RetryAfterSeconds is zero unless the upstream rate limiter provided one.
type MosooError struct {
	Code              string
	Message           string
	RetryAfterSeconds int
}

func (e *MosooError) Error() string { return e.Message }

// IsRetryableMosooError mirrors isRetryableMosooCreateError: only an
// unavailable upstream or an explicit rate limit earns another attempt.
func IsRetryableMosooError(err error) bool {
	mosooErr, ok := err.(*MosooError)
	return ok && (mosooErr.Code == MosooUnavailable || mosooErr.Code == MosooRateLimited)
}

type MosooRunError struct {
	Code      string
	Message   string
	Retryable bool
}

// MosooThreadSnapshot mirrors MosooThreadSnapshot: the run state plus the
// deduplicated, product-safe public activities derived from raw events.
type MosooThreadSnapshot struct {
	ThreadID   string
	RunID      string
	RunStatus  string
	Kind       string
	EventTypes []string
	Activities []ProjectAnalysisActivity
	RunError   *MosooRunError
}

type MosooProjectArtifacts struct {
	AnalysisJSON   string
	EvidenceJSON   string
	ReportMarkdown string
}

// MosooClient is a thin Public Thread API client. Every request carries the
// Bearer token and respects the configured per-request timeout.
type MosooClient struct {
	base    string
	token   string
	agentID string
	userID  string
	client  *http.Client
}

func NewMosooClient(config Config) *MosooClient {
	timeout := config.MosooRequestTimeout
	if timeout < time.Second {
		timeout = 15 * time.Second
	}
	userID := strings.TrimSpace(config.MosooUserID)
	if userID == "" {
		userID = "ghfind"
	}
	return &MosooClient{
		base:    strings.TrimRight(config.MosooAPIBase, "/"),
		token:   config.MosooAPIToken,
		agentID: config.MosooProjectAgentID,
		userID:  userID,
		client:  &http.Client{Timeout: timeout},
	}
}

func (c *MosooClient) AgentID() string { return c.agentID }

// mosooRunStatuses is the run status enum from the TypeScript runStatusSchema.
var mosooRunStatuses = map[string]bool{
	"queued": true, "booting": true, "running": true, "waiting_input": true,
	"completed": true, "failed": true, "cancelled": true, "expired": true,
}

var mosooThreadStatuses = map[string]bool{
	"IDLE": true, "RUNNING": true, "RESCHEDULING": true, "TERMINATED": true,
}

type mosooRunPayload struct {
	ID          string  `json:"id"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"createdAt"`
	StartedAt   *string `json:"startedAt"`
	CompletedAt *string `json:"completedAt"`
	UpdatedAt   string  `json:"updatedAt"`
	Trigger     string  `json:"trigger"`
	Error       *struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	} `json:"error"`
}

type mosooThreadPayload struct {
	Thread struct {
		ID                string  `json:"id"`
		AgentID           string  `json:"agent_id"`
		Kind              string  `json:"kind"`
		Status            string  `json:"status"`
		ClientExternalRef *string `json:"client_external_ref"`
	} `json:"thread"`
	Run *mosooRunPayload `json:"run"`
}

type mosooEvent struct {
	ID         string   `json:"id"`
	Type       string   `json:"type"`
	Status     string   `json:"status"`
	Content    string   `json:"content"`
	OccurredAt string   `json:"occurredAt"`
	DurationMs *float64 `json:"durationMs"`
	Tokens     *float64 `json:"tokens"`
}

type mosooEventsPayload struct {
	Events    []mosooEvent `json:"events"`
	Truncated bool         `json:"truncated"`
}

type mosooFileEntry struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Committed bool    `json:"committed"`
	Size      int64   `json:"size"`
	MimeType  *string `json:"mimeType"`
}

type mosooFilesPayload struct {
	Files []mosooFileEntry `json:"files"`
}

func (run *mosooRunPayload) valid() bool {
	return run != nil && run.ID != "" && mosooRunStatuses[run.Status] &&
		run.CreatedAt != "" && run.UpdatedAt != ""
}

func (payload *mosooThreadPayload) valid() bool {
	if payload == nil || payload.Thread.ID == "" || payload.Thread.AgentID == "" {
		return false
	}
	if payload.Thread.Kind != "pet" && payload.Thread.Kind != "cattle" {
		return false
	}
	return mosooThreadStatuses[payload.Thread.Status]
}

func (event *mosooEvent) valid() bool {
	if event.ID == "" || event.Content == "" || event.OccurredAt == "" {
		return false
	}
	return event.Status == "available" || event.Status == "error" || event.Status == "unsupported"
}

// do performs one authenticated request and maps every failure onto the
// public Mosoo error codes, mirroring mosooFetch and mapApiError.
func (c *MosooClient) do(ctx context.Context, method, path, accept string, body []byte, headers map[string]string) ([]byte, error) {
	if c.token == "" {
		return nil, &MosooError{
			Code:    MosooUnauthenticated,
			Message: "MOSOO_API_TOKEN is required for project analysis.",
		}
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return nil, &MosooError{Code: MosooUnavailable, Message: err.Error()}
	}
	if accept == "" {
		accept = "application/json"
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("Authorization", "Bearer "+c.token)
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := c.client.Do(request)
	if err != nil {
		message := err.Error()
		if ctx.Err() != nil {
			message = "Mosoo project analysis request timed out."
		}
		return nil, &MosooError{Code: MosooUnavailable, Message: message}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, &MosooError{Code: MosooUnavailable, Message: err.Error()}
	}
	if response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
		return data, nil
	}
	return nil, mapMosooAPIError(response, data)
}

// mapMosooAPIError mirrors mapApiError, including the upstream error envelope
// parsing and the Retry-After passthrough.
func mapMosooAPIError(response *http.Response, body []byte) error {
	upstreamCode := "unknown"
	message := fmt.Sprintf("Mosoo Public Thread API returned HTTP %d.", response.StatusCode)
	var envelope struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err == nil && envelope.Error != nil && envelope.Error.Code != "" {
		upstreamCode = envelope.Error.Code
		if envelope.Error.Message != "" {
			message = envelope.Error.Message
		} else {
			message = upstreamCode
		}
	}
	switch response.StatusCode {
	case http.StatusUnauthorized:
		return &MosooError{Code: MosooUnauthenticated, Message: message}
	case http.StatusForbidden, http.StatusNotFound:
		return &MosooError{Code: MosooForbidden, Message: message}
	case http.StatusConflict:
		return &MosooError{Code: MosooNotReady, Message: message}
	case http.StatusTooManyRequests:
		retryAfter := 0
		if raw := strings.TrimSpace(response.Header.Get("Retry-After")); raw != "" {
			if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
				retryAfter = seconds
			}
		}
		return &MosooError{Code: MosooRateLimited, Message: message, RetryAfterSeconds: retryAfter}
	default:
		return &MosooError{Code: MosooUnavailable, Message: message}
	}
}

// buildProjectAnalysisPrompt mirrors buildProjectAnalysisPrompt: every
// version line is pinned so the Cattle Agent writes artifacts for exactly the
// rubric and schema the persistence layer validates. The REPORT_CONTRACT
// block travels in the task itself because the Mosoo agent runs a registered
// skill snapshot we cannot update over the API; task-level instructions
// override the snapshot's report style.
func buildProjectAnalysisPrompt(run *ProjectAnalysisRun, executionMode string) string {
	requestedRef := ""
	if run.RequestedRef != nil {
		requestedRef = *run.RequestedRef
	}
	protocolVersion := "V2"
	if run.SchemaVersion == ProjectAnalysisSchemaVersion {
		protocolVersion = "V3"
	}
	return strings.Join([]string{
		"[GHFIND_PROJECT_ANALYSIS_" + protocolVersion + "]",
		"analysis_id: " + run.ID,
		"repository_url: " + run.CanonicalURL,
		"requested_ref: " + requestedRef,
		"execution_mode: " + executionMode,
		"rubric_version: " + run.RubricVersion,
		"schema_version: " + run.SchemaVersion,
		"artifact_prefix: project-analysis-" + run.ID,
		"locale: zh-CN",
		"",
		"[REPORT_CONTRACT]",
		"报告是 analysis JSON 的读者视图，分数只能出自 JSON，不得改分或与 rationale 矛盾。",
		"按以下六维度章节顺序成文（zh-CN 标题必须原样使用，每节先一句明确判断再给证据）：",
		"# 产品潜力分析：<project name>",
		"## 产品价值（X/100）：product_score · confidence · verification_level，加 1-3 句总判断（值得关注吗、给谁看、为什么）。",
		"## 需求痛点（X/25）：痛点是否真实（真实且高频/真实但小众/存疑）、发生在谁身上、没有本项目时的具体工作流、现有替代方案为何不够。",
		"## 解决效果（X/30）：核心承诺 → 已验证的实现证据 → 未验证的部分与缺口；明确回答方案是否闭环解决了上述痛点。",
		"## 上手与核心体验（X/30）：发现 → 安装 → 配置 → 首次成功 → 出错反馈，五步各一句判断；验证过的写清实际观察到的行为。",
		"## 范围与价值密度（X/15）：功能边界是否克制、复杂度是否物有所值；指出可砍掉的部分（如有）。",
		"## 风险：risks 与 unknowns 逐条（没有就写「无」），每条一句判断加一句依据。unknowns 最多 4 条且必须是决策相关的未知（知道后会影响评分/置信/采用决策，并写明影响什么），验证范围事实（本次没构建/没运行）只写进「验证方式与可信度」，不得进 unknowns；禁止「未验证 X」「无法确认 Y」式模板句。",
		"## 验证方式与可信度：本次实际执行了哪个验证级别、做了什么、没做什么、置信度为什么是这个数。",
		"## 曝光与社区（不计入 product_score）：曝光档位与社区强度的客观上下文，以及因此进入哪个榜单或不进榜的原因。",
		"硬性风格：每节至少两段（判断段+证据段），每段不超过 5 句；证据必须可核对（具体文件/命令行为/文档内容/数据），不可核对的写入 unknowns 不得臆测；",
		"禁止第一人称自述：报告是给读者的产品分析，不是 agent 的工作日志。不得出现「我」「本次我」作为主语；验证范围一律用无人称表述，例如「本次验证未覆盖构建与执行（source_only）」而不是「我没有构建」。",
		"禁止填充语：值得注意的是、综上所述、不难发现、总的来说、在某种程度上及同义表达；「不是 X，而是 Y」式排比全篇最多一次；单句最多引用两个方法名/路径名/类名，实现细节归入 evidence JSON。",
	}, "\n")
}

// CreateProjectAnalysisThread mirrors createMosooProjectAnalysisThread. A
// pet-kind Agent is rejected: project analysis requires a cattle Agent. The
// live Mosoo API identifies the caller with a userId field; the historical
// client_external_ref is rejected with a 400 invalid_request.
func (c *MosooClient) CreateProjectAnalysisThread(ctx context.Context, run *ProjectAnalysisRun, executionMode string) (*MosooThreadSnapshot, error) {
	if c.agentID == "" {
		return nil, &MosooError{
			Code:    MosooNotReady,
			Message: "MOSOO_PROJECT_AGENT_ID is required and cannot fall back to the account Agent.",
		}
	}
	body, err := json.Marshal(map[string]any{
		"userId": c.userID,
		"input": map[string]any{
			"type":    "user.message",
			"content": []map[string]string{{"type": "text", "text": buildProjectAnalysisPrompt(run, executionMode)}},
		},
	})
	if err != nil {
		return nil, &MosooError{Code: MosooUnavailable, Message: err.Error()}
	}
	data, err := c.do(ctx, http.MethodPost, "/agents/"+c.agentID+"/threads", "application/json", body, map[string]string{
		"Content-Type":    "application/json",
		"Idempotency-Key": run.IdempotencyKey,
	})
	if err != nil {
		return nil, err
	}
	var payload mosooThreadPayload
	if err := json.Unmarshal(data, &payload); err != nil || !payload.valid() || !payload.Run.valid() {
		return nil, &MosooError{
			Code:    MosooInvalidResponse,
			Message: "Mosoo returned an invalid create-Thread response.",
		}
	}
	if payload.Thread.Kind != "cattle" {
		return nil, &MosooError{
			Code:    MosooInvalidResponse,
			Message: "Project analysis requires a cattle Agent.",
		}
	}
	return &MosooThreadSnapshot{
		ThreadID:   payload.Thread.ID,
		RunID:      payload.Run.ID,
		RunStatus:  payload.Run.Status,
		Kind:       payload.Thread.Kind,
		EventTypes: []string{},
		Activities: []ProjectAnalysisActivity{},
		RunError:   mosooRunError(payload.Run),
	}, nil
}

// GetProjectAnalysisSnapshot mirrors getMosooProjectAnalysisSnapshot: the
// thread state plus the last 100 events reduced to public activities.
func (c *MosooClient) GetProjectAnalysisSnapshot(ctx context.Context, threadID string) (*MosooThreadSnapshot, error) {
	threadData, err := c.do(ctx, http.MethodGet, "/threads/"+threadID, "", nil, nil)
	if err != nil {
		return nil, err
	}
	eventData, err := c.do(ctx, http.MethodGet, "/threads/"+threadID+"/events?limit=100", "", nil, nil)
	if err != nil {
		return nil, err
	}
	var thread mosooThreadPayload
	var events mosooEventsPayload
	threadOK := json.Unmarshal(threadData, &thread) == nil && thread.valid() && thread.Run.valid()
	eventsOK := json.Unmarshal(eventData, &events) == nil
	if eventsOK {
		for index := range events.Events {
			if !events.Events[index].valid() {
				eventsOK = false
				break
			}
		}
	}
	if !threadOK || !eventsOK {
		return nil, &MosooError{
			Code:    MosooInvalidResponse,
			Message: "Mosoo returned an invalid Thread snapshot.",
		}
	}
	eventTypes := make([]string, 0, len(events.Events))
	for _, event := range events.Events {
		eventTypes = append(eventTypes, event.Type)
	}
	return &MosooThreadSnapshot{
		ThreadID:   thread.Thread.ID,
		RunID:      thread.Run.ID,
		RunStatus:  thread.Run.Status,
		Kind:       thread.Thread.Kind,
		EventTypes: eventTypes,
		Activities: PublicProjectAnalysisActivities(events.Events),
		RunError:   mosooRunError(thread.Run),
	}, nil
}

func mosooRunError(run *mosooRunPayload) *MosooRunError {
	if run == nil || run.Error == nil {
		return nil
	}
	return &MosooRunError{Code: run.Error.Code, Message: run.Error.Message, Retryable: run.Error.Retryable}
}

// ReadProjectAnalysisArtifacts mirrors readMosooProjectAnalysisArtifacts: the
// three artifacts are matched by exact file name among committed artifacts
// and downloaded inline.
func (c *MosooClient) ReadProjectAnalysisArtifacts(ctx context.Context, threadID, analysisID string) (*MosooProjectArtifacts, error) {
	data, err := c.do(ctx, http.MethodGet, "/threads/"+threadID+"/files", "", nil, nil)
	if err != nil {
		return nil, err
	}
	var payload mosooFilesPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, &MosooError{
			Code:    MosooInvalidResponse,
			Message: "Mosoo returned an invalid Thread file list.",
		}
	}
	for _, file := range payload.Files {
		if file.ID == "" || (file.Kind != "attachment" && file.Kind != "artifact") || file.Size < 0 {
			return nil, &MosooError{
				Code:    MosooInvalidResponse,
				Message: "Mosoo returned an invalid Thread file list.",
			}
		}
	}
	artifacts := map[string]mosooFileEntry{}
	for _, file := range payload.Files {
		if file.Kind == "artifact" && file.Committed {
			artifacts[file.Name] = file
		}
	}
	analysis, hasAnalysis := artifacts["project-analysis-"+analysisID+".json"]
	evidence, hasEvidence := artifacts["runtime-evidence-"+analysisID+".json"]
	report, hasReport := artifacts["project-report-"+analysisID+".md"]
	if !hasAnalysis || !hasEvidence || !hasReport {
		return nil, &MosooError{
			Code:    MosooArtifactMissing,
			Message: "Completed Mosoo run is missing one or more required project artifacts.",
		}
	}
	if analysis.Size > projectAnalysisArtifactMaxLength ||
		evidence.Size > projectEvidenceArtifactMaxLength ||
		report.Size > projectReportMaxLength {
		return nil, &MosooError{
			Code:    MosooInvalidResponse,
			Message: "Project analysis artifact exceeds the configured size limit.",
		}
	}
	analysisJSON, err := c.downloadArtifact(ctx, analysis.ID)
	if err != nil {
		return nil, err
	}
	evidenceJSON, err := c.downloadArtifact(ctx, evidence.ID)
	if err != nil {
		return nil, err
	}
	reportMarkdown, err := c.downloadArtifact(ctx, report.ID)
	if err != nil {
		return nil, err
	}
	return &MosooProjectArtifacts{
		AnalysisJSON:   analysisJSON,
		EvidenceJSON:   evidenceJSON,
		ReportMarkdown: reportMarkdown,
	}, nil
}

func (c *MosooClient) downloadArtifact(ctx context.Context, fileID string) (string, error) {
	data, err := c.do(ctx, http.MethodGet, "/files/"+fileID+"/content?disposition=inline", "application/octet-stream", nil, nil)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Activity classification mirrors classifyActivity and
// publicProjectAnalysisActivities. Event content is only used to pick a kind
// and is never copied into an activity, so agent output (including any
// secret it prints) cannot leak into the public view.
var (
	activityValidatingPattern = regexp.MustCompile(`validate_artifacts|validate|schema|校验`)
	activityEvaluatingPattern = regexp.MustCompile(`score|scoring|rubric|evidence|评分|证据`)
	activityWritingPattern    = regexp.MustCompile(`project-report|project-analysis|runtime-evidence|/outputs|mkdir.*outputs|\bwrite\b`)
	activityCommunityPattern  = regexp.MustCompile(`api\.github\.com|contributors|issues|pulls|releases|stars|forks`)
	activityHistoryPattern    = regexp.MustCompile(`git log|git shortlog|git branch|commit history|提交历史`)
	activityDocsPattern       = regexp.MustCompile(`readme|/docs/|docs/|spec\.md|architecture|contributing|license|prd`)
)

func classifyMosooActivity(event mosooEvent) string {
	content := strings.ToLower(event.Content)
	switch event.Type {
	case "run.started":
		return "started"
	case "run.completed":
		return "completed"
	case "run.failed":
		return "failed"
	case "file.changed", "session_files.updated":
		return "saving"
	case "tool.use.started":
	default:
		return ""
	}
	switch {
	case activityValidatingPattern.MatchString(content):
		return "validating"
	case activityEvaluatingPattern.MatchString(content):
		return "evaluating"
	case activityWritingPattern.MatchString(content):
		return "writing"
	case activityCommunityPattern.MatchString(content):
		return "checking_community"
	case activityHistoryPattern.MatchString(content):
		return "inspecting_history"
	case activityDocsPattern.MatchString(content):
		return "inspecting_docs"
	default:
		return "inspecting_source"
	}
}

// PublicProjectAnalysisActivities mirrors publicProjectAnalysisActivities:
// events are sorted by occurredAt, adjacent duplicates of one kind collapse,
// and only the last eight survive.
func PublicProjectAnalysisActivities(events []mosooEvent) []ProjectAnalysisActivity {
	sorted := make([]mosooEvent, len(events))
	copy(sorted, events)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].OccurredAt < sorted[j].OccurredAt
	})
	activities := []ProjectAnalysisActivity{}
	for _, event := range sorted {
		kind := classifyMosooActivity(event)
		if kind == "" {
			continue
		}
		if len(activities) > 0 && activities[len(activities)-1].Kind == kind {
			continue
		}
		activities = append(activities, ProjectAnalysisActivity{
			ID:         event.ID,
			Kind:       kind,
			OccurredAt: event.OccurredAt,
		})
	}
	if len(activities) > 8 {
		activities = activities[len(activities)-8:]
	}
	return activities
}
