package backend

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Keep every constant, rule, and message in this file synchronized with
// src/lib/project-analysis-contract.ts and src/lib/project-ranking.ts. The
// TypeScript sources remain the single source of truth while the analysis
// pipeline is migrated.
const (
	LegacyProjectAnalysisSchemaVersion = "ghfind.project-analysis.v1"
	ProjectAnalysisSchemaVersion       = "ghfind.project-analysis.v2"
	ProjectRubricVersion               = "project-value-v1"
	ProjectAgentVersion                = "project-evaluator-v2"
	ProjectSkillVersion                = "ghfind-project-evaluator-v3"
)

// Sentinel errors distinguish contract failures from infrastructure failures
// so callers can map them to the same public error codes as the Next service.
var (
	ErrInvalidRepository = errors.New("invalid_repository")
	ErrInvalidRef        = errors.New("invalid_ref")
	ErrArtifactInvalid   = errors.New("artifact_invalid")
)

// Analysis artifact size limits, mirroring parseProjectAnalysisArtifacts.
const (
	projectAnalysisArtifactMaxLength = 512_000
	projectEvidenceArtifactMaxLength = 1_500_000
	projectReportMaxLength           = 500_000
	projectErrorMessageMaxLength     = 2_000
)

type ProjectAnalysisStatus = string

const (
	ProjectAnalysisStatusQueued         ProjectAnalysisStatus = "queued"
	ProjectAnalysisStatusCreatingThread ProjectAnalysisStatus = "creating_thread"
	ProjectAnalysisStatusRunning        ProjectAnalysisStatus = "running"
	ProjectAnalysisStatusFinalizing     ProjectAnalysisStatus = "finalizing"
	ProjectAnalysisStatusCompleted      ProjectAnalysisStatus = "completed"
	ProjectAnalysisStatusFailed         ProjectAnalysisStatus = "failed"
	ProjectAnalysisStatusCancelled      ProjectAnalysisStatus = "cancelled"
	ProjectAnalysisStatusExpired        ProjectAnalysisStatus = "expired"
)

// ProjectAnalysisActivity mirrors the camelCase activity schema stored in
// project_analysis_runs.activities_json.
type ProjectAnalysisActivity struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	OccurredAt string `json:"occurredAt"`
}

type NormalizedGitHubRepository struct {
	RepoKey       string
	NameWithOwner string
	CanonicalURL  string
}

type ScoreDimension struct {
	Score       int64    `json:"score"`
	MaxScore    int64    `json:"max_score"`
	Rationale   string   `json:"rationale"`
	EvidenceIDs []string `json:"evidence_ids"`
}

type ProjectAnalysisScores struct {
	Pain          ScoreDimension `json:"pain"`
	Effectiveness ScoreDimension `json:"effectiveness"`
	Experience    ScoreDimension `json:"experience"`
	ValueDensity  ScoreDimension `json:"value_density"`
	ProductScore  int64          `json:"product_score"`
}

type ProductTagLabels struct {
	Zh string `json:"zh"`
	En string `json:"en"`
}

type ProductTag struct {
	Slug        string           `json:"slug"`
	Labels      ProductTagLabels `json:"labels"`
	EvidenceIDs []string         `json:"evidence_ids"`
}

type ProjectInfo struct {
	Name          string       `json:"name"`
	Summary       string       `json:"summary"`
	TargetUsers   []string     `json:"target_users"`
	PainStatement string       `json:"pain_statement"`
	ProjectType   string       `json:"project_type"`
	Lifecycle     string       `json:"lifecycle"`
	ProductTags   []ProductTag `json:"product_tags"`
}

type ProjectRisk struct {
	Severity    string   `json:"severity"`
	Category    string   `json:"category"`
	Summary     string   `json:"summary"`
	EvidenceIDs []string `json:"evidence_ids"`
}

type ProjectCommunityStrength struct {
	Score       float64  `json:"score"`
	Rationale   string   `json:"rationale"`
	EvidenceIDs []string `json:"evidence_ids"`
}

type ProjectExposure struct {
	Band        string   `json:"band"`
	Stars       *int64   `json:"stars"`
	Dependents  *int64   `json:"dependents"`
	Downloads   *int64   `json:"downloads"`
	Rationale   string   `json:"rationale"`
	EvidenceIDs []string `json:"evidence_ids"`
}

type ProjectAnalysisRepository struct {
	RepoKey           string  `json:"repo_key"`
	CanonicalURL      string  `json:"canonical_url"`
	RequestedRef      *string `json:"requested_ref"`
	ResolvedCommitSHA string  `json:"resolved_commit_sha"`
}

type ProjectAnalysisArtifact struct {
	SchemaVersion     string                    `json:"schema_version"`
	AnalysisID        string                    `json:"analysis_id"`
	Repository        ProjectAnalysisRepository `json:"repository"`
	RubricVersion     string                    `json:"rubric_version"`
	AgentVersion      string                    `json:"agent_version"`
	SkillVersion      string                    `json:"skill_version"`
	Project           ProjectInfo               `json:"project"`
	Scores            ProjectAnalysisScores     `json:"scores"`
	Confidence        float64                   `json:"confidence"`
	VerificationLevel string                    `json:"verification_level"`
	Unknowns          []string                  `json:"unknowns"`
	Risks             []ProjectRisk             `json:"risks"`
	CommunityStrength ProjectCommunityStrength  `json:"community_strength"`
	Exposure          ProjectExposure           `json:"exposure"`
	AnalyzedAt        string                    `json:"analyzed_at"`
}

type RuntimeEvidenceEntry struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Summary  string `json:"summary"`
	Outcome  string `json:"outcome"`
	Command  string `json:"command,omitempty"`
	Path     string `json:"path,omitempty"`
	ExitCode *int64 `json:"exit_code,omitempty"`
	Excerpt  string `json:"excerpt,omitempty"`
}

type RuntimeEvidenceArtifact struct {
	SchemaVersion     string                 `json:"schema_version"`
	AnalysisID        string                 `json:"analysis_id"`
	RepoKey           string                 `json:"repo_key"`
	ResolvedCommitSHA string                 `json:"resolved_commit_sha"`
	Entries           []RuntimeEvidenceEntry `json:"entries"`
}

// ProjectAnalysisRunIdentity carries the run fields an artifact must match
// before finalization, mirroring completeProjectAnalysisRun in the service.
type ProjectAnalysisRunIdentity struct {
	RubricVersion string
	AgentVersion  string
	SkillVersion  string
	RequestedRef  *string
}

type ProjectAnalysisArtifactsInput struct {
	AnalysisRaw        string
	EvidenceRaw        string
	ReportMarkdown     string
	ExpectedAnalysisID string
	ExpectedRepoKey    string
	// ExpectedRun is optional; when set, artifact rubric/agent/skill versions
	// and the requested ref must match the analysis run.
	ExpectedRun *ProjectAnalysisRunIdentity
}

type ParsedProjectAnalysisArtifacts struct {
	Analysis       *ProjectAnalysisArtifact
	Evidence       *RuntimeEvidenceArtifact
	ReportMarkdown string
}

var (
	githubOwnerPattern        = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)
	githubRepoPattern         = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	resolvedCommitSHAPattern  = regexp.MustCompile(`(?i)^[0-9a-f]{40}$`)
	productTagSlugPattern     = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	invalidRequestedRefChars  = regexp.MustCompile("[\x00-\x20~^:?*\\[\\\\]")
	githubRepositoryURLPrefix = regexp.MustCompile(`^https?://`)
)

// NormalizeGitHubRepository mirrors normalizeGitHubRepository in the contract
// module: it accepts an https GitHub URL or an owner/repository shorthand and
// returns the canonical identity used as a persistence key.
func NormalizeGitHubRepository(raw string) (NormalizedGitHubRepository, error) {
	invalid := NormalizedGitHubRepository{}
	input := strings.TrimSpace(raw)
	if input == "" || utf8.RuneCountInString(input) > 500 {
		return invalid, ErrInvalidRepository
	}

	path := input
	if githubRepositoryURLPrefix.MatchString(strings.ToLower(input)) {
		parsed, err := url.Parse(input)
		if err != nil {
			return invalid, ErrInvalidRepository
		}
		hostname := strings.ToLower(parsed.Hostname())
		port := parsed.Port()
		// WHATWG URL drops the default https port; mirror that allowance.
		if port == "443" {
			port = ""
		}
		invalidCredentials := false
		if parsed.User != nil {
			_, hasPassword := parsed.User.Password()
			invalidCredentials = parsed.User.Username() != "" || hasPassword
		}
		if (hostname != "github.com" && hostname != "www.github.com") ||
			!strings.EqualFold(parsed.Scheme, "https") ||
			port != "" || invalidCredentials ||
			parsed.RawQuery != "" || parsed.Fragment != "" {
			return invalid, ErrInvalidRepository
		}
		path = parsed.EscapedPath()
	}

	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) != 2 {
		return invalid, ErrInvalidRepository
	}
	owner := segments[0]
	repository := segments[1]
	if strings.HasSuffix(strings.ToLower(repository), ".git") {
		repository = repository[:len(repository)-len(".git")]
	}
	if !githubOwnerPattern.MatchString(owner) || !githubRepoPattern.MatchString(repository) {
		return invalid, ErrInvalidRepository
	}

	nameWithOwner := owner + "/" + repository
	return NormalizedGitHubRepository{
		RepoKey:       strings.ToLower(nameWithOwner),
		NameWithOwner: nameWithOwner,
		CanonicalURL:  "https://github.com/" + nameWithOwner,
	}, nil
}

// NormalizeRequestedRef mirrors normalizeRequestedRef in the service: blank
// refs mean "default branch" (nil), everything else must be a valid Git ref.
func NormalizeRequestedRef(value string) (*string, error) {
	ref := strings.TrimSpace(value)
	if ref == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(ref) > 200 ||
		invalidRequestedRefChars.MatchString(ref) ||
		strings.HasPrefix(ref, "-") ||
		strings.Contains(ref, "..") ||
		strings.Contains(ref, "@{") {
		return nil, ErrInvalidRef
	}
	return &ref, nil
}

func joinFingerprintParts(parts ...string) string {
	return strings.Join(parts, "\x00")
}

// ProjectAnalysisResultFingerprint mirrors projectAnalysisResultFingerprint:
// it identifies a completed analysis reusable for an identical request.
func ProjectAnalysisResultFingerprint(repoKey string, requestedRef *string, schemaVersion, rubricVersion, agentVersion, skillVersion string) string {
	ref := ""
	if requestedRef != nil {
		ref = *requestedRef
	}
	sum := sha256.Sum256([]byte(joinFingerprintParts(
		strings.ToLower(repoKey), ref, schemaVersion, rubricVersion, agentVersion, skillVersion,
	)))
	return hex.EncodeToString(sum[:])
}

// ProjectAnalysisActiveKey mirrors activeKey in project-analysis-db.ts: at
// most one non-terminal run exists per repository, ref, and rubric.
func ProjectAnalysisActiveKey(repoKey string, requestedRef *string, rubricVersion string) string {
	ref := ""
	if requestedRef != nil {
		ref = *requestedRef
	}
	sum := sha256.Sum256([]byte(joinFingerprintParts(strings.ToLower(repoKey), ref, rubricVersion)))
	return hex.EncodeToString(sum[:])
}

func artifactErrorf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrArtifactInvalid, fmt.Sprintf(format, args...))
}

func requiredTrimmedString(value *string, field string, minLength, maxLength int) (string, error) {
	if value == nil {
		return "", artifactErrorf("%s is required", field)
	}
	trimmed := strings.TrimSpace(*value)
	length := utf8.RuneCountInString(trimmed)
	if length < minLength || length > maxLength {
		return "", artifactErrorf("%s must be between %d and %d characters", field, minLength, maxLength)
	}
	return trimmed, nil
}

func requiredEnum(value *string, field string, allowed ...string) (string, error) {
	if value == nil {
		return "", artifactErrorf("%s is required", field)
	}
	for _, candidate := range allowed {
		if *value == candidate {
			return *value, nil
		}
	}
	return "", artifactErrorf("%s has an unsupported value %q", field, *value)
}

func parseArtifactNumber(value *json.Number, field string) (float64, bool, error) {
	if value == nil {
		return 0, false, artifactErrorf("%s is required", field)
	}
	number, err := strconv.ParseFloat(value.String(), 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false, artifactErrorf("%s must be a number", field)
	}
	return number, true, nil
}

func requiredArtifactInt(value *json.Number, field string, minValue, maxValue int64) (int64, error) {
	number, _, err := parseArtifactNumber(value, field)
	if err != nil {
		return 0, err
	}
	if math.Trunc(number) != number {
		return 0, artifactErrorf("%s must be an integer", field)
	}
	integer := int64(number)
	if integer < minValue || integer > maxValue {
		return 0, artifactErrorf("%s must be between %d and %d", field, minValue, maxValue)
	}
	return integer, nil
}

func requiredArtifactFloat(value *json.Number, field string, minValue, maxValue float64) (float64, error) {
	number, _, err := parseArtifactNumber(value, field)
	if err != nil {
		return 0, err
	}
	if number < minValue || number > maxValue {
		return 0, artifactErrorf("%s must be between %v and %v", field, minValue, maxValue)
	}
	return number, nil
}

func optionalNullableArtifactInt(value *json.Number, field string) (*int64, error) {
	if value == nil {
		return nil, nil
	}
	integer, err := requiredArtifactInt(value, field, 0, math.MaxInt64)
	if err != nil {
		return nil, err
	}
	return &integer, nil
}

func requiredStringArray(value *[]string, field string, minItems, maxItems int) ([]string, error) {
	if value == nil {
		return nil, artifactErrorf("%s is required", field)
	}
	if len(*value) < minItems || len(*value) > maxItems {
		return nil, artifactErrorf("%s must contain between %d and %d entries", field, minItems, maxItems)
	}
	return *value, nil
}

func requiredTrimmedStringArray(value *[]string, field string, minItems, maxItems, maxLength int) ([]string, error) {
	items, err := requiredStringArray(value, field, minItems, maxItems)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for index, item := range items {
		entryField := fmt.Sprintf("%s[%d]", field, index)
		entry := item
		trimmed, err := requiredTrimmedString(&entry, entryField, 1, maxLength)
		if err != nil {
			return nil, err
		}
		out = append(out, trimmed)
	}
	return out, nil
}

func requiredEvidenceIDs(value *[]string, field string, minItems, maxItems int) ([]string, error) {
	return requiredTrimmedStringArray(value, field, minItems, maxItems, 100)
}

var projectTypeAliases = map[string]string{
	"micro-tool":         "micro_tool",
	"sdk-library":        "sdk_library",
	"web-app":            "web_app",
	"desktop-app":        "desktop_app",
	"framework-platform": "framework_platform",
	"database-infra":     "database_infra",
	"template-scaffold":  "template_scaffold",
	"enterprise-system":  "enterprise_system",
}

var projectTypes = []string{
	"micro_tool", "sdk_library", "web_app", "desktop_app",
	"framework_platform", "database_infra", "template_scaffold", "enterprise_system",
}

var projectLifecycles = []string{
	"active_evolution", "stable_maintenance", "feature_complete", "experimental", "abandoned",
}

var verificationLevels = []string{
	"metadata_only", "source_inspected", "built", "core_flow_executed",
}

var exposureBands = []string{
	"unknown", "low", "emerging", "established", "mainstream",
}

var riskSeverities = []string{"info", "low", "medium", "high", "critical"}

var riskCategories = []string{
	"license", "security", "supply_chain", "maintenance",
	"compatibility", "privacy", "operations", "other",
}

var evidenceKinds = []string{
	"metadata", "source", "documentation", "command", "build", "test", "runtime", "external",
}

var evidenceOutcomes = []string{"pass", "fail", "partial", "unknown"}

type rawScoreDimension struct {
	Score       *json.Number `json:"score"`
	MaxScore    *json.Number `json:"max_score"`
	Rationale   *string      `json:"rationale"`
	EvidenceIDs *[]string    `json:"evidence_ids"`
}

type rawProductTag struct {
	Slug   *string `json:"slug"`
	Labels *struct {
		Zh *string `json:"zh"`
		En *string `json:"en"`
	} `json:"labels"`
	EvidenceIDs *[]string `json:"evidence_ids"`
}

type rawProject struct {
	Name          *string          `json:"name"`
	Summary       *string          `json:"summary"`
	TargetUsers   *[]string        `json:"target_users"`
	PainStatement *string          `json:"pain_statement"`
	ProjectType   *string          `json:"project_type"`
	Lifecycle     *string          `json:"lifecycle"`
	ProductTags   *[]rawProductTag `json:"product_tags"`
}

type rawRisk struct {
	Severity    *string   `json:"severity"`
	Category    *string   `json:"category"`
	Summary     *string   `json:"summary"`
	Description *string   `json:"description"`
	Title       *string   `json:"title"`
	EvidenceIDs *[]string `json:"evidence_ids"`
}

type rawCommunityStrength struct {
	Score       *json.Number `json:"score"`
	Rationale   *string      `json:"rationale"`
	EvidenceIDs *[]string    `json:"evidence_ids"`
}

type rawExposure struct {
	Band        *string      `json:"band"`
	Stars       *json.Number `json:"stars"`
	Dependents  *json.Number `json:"dependents"`
	Downloads   *json.Number `json:"downloads"`
	Rationale   *string      `json:"rationale"`
	EvidenceIDs *[]string    `json:"evidence_ids"`
}

type rawAnalysisArtifact struct {
	SchemaVersion *string `json:"schema_version"`
	AnalysisID    *string `json:"analysis_id"`
	Repository    *struct {
		RepoKey           *string `json:"repo_key"`
		CanonicalURL      *string `json:"canonical_url"`
		RequestedRef      *string `json:"requested_ref"`
		ResolvedCommitSHA *string `json:"resolved_commit_sha"`
	} `json:"repository"`
	RubricVersion *string     `json:"rubric_version"`
	AgentVersion  *string     `json:"agent_version"`
	SkillVersion  *string     `json:"skill_version"`
	Project       *rawProject `json:"project"`
	Scores        *struct {
		Pain          *rawScoreDimension `json:"pain"`
		Effectiveness *rawScoreDimension `json:"effectiveness"`
		Experience    *rawScoreDimension `json:"experience"`
		ValueDensity  *rawScoreDimension `json:"value_density"`
		ProductScore  *json.Number       `json:"product_score"`
	} `json:"scores"`
	Confidence        *json.Number          `json:"confidence"`
	VerificationLevel *string               `json:"verification_level"`
	Unknowns          *[]string             `json:"unknowns"`
	Risks             *[]json.RawMessage    `json:"risks"`
	CommunityStrength *rawCommunityStrength `json:"community_strength"`
	Exposure          *rawExposure          `json:"exposure"`
	AnalyzedAt        *string               `json:"analyzed_at"`
}

type rawEvidenceArtifact struct {
	SchemaVersion     *string `json:"schema_version"`
	AnalysisID        *string `json:"analysis_id"`
	RepoKey           *string `json:"repo_key"`
	ResolvedCommitSHA *string `json:"resolved_commit_sha"`
	Entries           *[]struct {
		ID       *string      `json:"id"`
		Kind     *string      `json:"kind"`
		Summary  *string      `json:"summary"`
		Outcome  *string      `json:"outcome"`
		Command  *string      `json:"command"`
		Path     *string      `json:"path"`
		ExitCode *json.Number `json:"exit_code"`
		Excerpt  *string      `json:"excerpt"`
	} `json:"entries"`
}

func parseSchemaVersion(value *string) (string, error) {
	return requiredEnum(value, "schema_version", ProjectAnalysisSchemaVersion, LegacyProjectAnalysisSchemaVersion)
}

func parseScoreDimension(raw *rawScoreDimension, field string, maxScore int64) (ScoreDimension, error) {
	if raw == nil {
		return ScoreDimension{}, artifactErrorf("%s is required", field)
	}
	score, err := requiredArtifactInt(raw.Score, field+".score", 0, maxScore)
	if err != nil {
		return ScoreDimension{}, err
	}
	maximum, err := requiredArtifactInt(raw.MaxScore, field+".max_score", maxScore, maxScore)
	if err != nil {
		return ScoreDimension{}, err
	}
	rationale, err := requiredTrimmedString(raw.Rationale, field+".rationale", 1, 2_000)
	if err != nil {
		return ScoreDimension{}, err
	}
	evidenceIDs, err := requiredEvidenceIDs(raw.EvidenceIDs, field+".evidence_ids", 1, 30)
	if err != nil {
		return ScoreDimension{}, err
	}
	return ScoreDimension{Score: score, MaxScore: maximum, Rationale: rationale, EvidenceIDs: evidenceIDs}, nil
}

func parseProductTag(raw *rawProductTag, field string) (ProductTag, error) {
	if raw == nil {
		return ProductTag{}, artifactErrorf("%s is required", field)
	}
	slug, err := requiredTrimmedString(raw.Slug, field+".slug", 2, 48)
	if err != nil {
		return ProductTag{}, err
	}
	if !productTagSlugPattern.MatchString(slug) {
		return ProductTag{}, artifactErrorf("%s.slug must be a lowercase kebab-case slug", field)
	}
	if raw.Labels == nil {
		return ProductTag{}, artifactErrorf("%s.labels is required", field)
	}
	zh, err := requiredTrimmedString(raw.Labels.Zh, field+".labels.zh", 1, 20)
	if err != nil {
		return ProductTag{}, err
	}
	en, err := requiredTrimmedString(raw.Labels.En, field+".labels.en", 1, 40)
	if err != nil {
		return ProductTag{}, err
	}
	evidenceIDs, err := requiredEvidenceIDs(raw.EvidenceIDs, field+".evidence_ids", 1, 10)
	if err != nil {
		return ProductTag{}, err
	}
	return ProductTag{Slug: slug, Labels: ProductTagLabels{Zh: zh, En: en}, EvidenceIDs: evidenceIDs}, nil
}

func parseProject(raw *rawProject) (ProjectInfo, error) {
	if raw == nil {
		return ProjectInfo{}, artifactErrorf("project is required")
	}
	name, err := requiredTrimmedString(raw.Name, "project.name", 1, 200)
	if err != nil {
		return ProjectInfo{}, err
	}
	summary, err := requiredTrimmedString(raw.Summary, "project.summary", 1, 2_000)
	if err != nil {
		return ProjectInfo{}, err
	}
	targetUsers, err := requiredTrimmedStringArray(raw.TargetUsers, "project.target_users", 1, 20, 200)
	if err != nil {
		return ProjectInfo{}, err
	}
	painStatement, err := requiredTrimmedString(raw.PainStatement, "project.pain_statement", 1, 2_000)
	if err != nil {
		return ProjectInfo{}, err
	}
	if raw.ProjectType == nil {
		return ProjectInfo{}, artifactErrorf("project.project_type is required")
	}
	projectType := *raw.ProjectType
	if alias, ok := projectTypeAliases[projectType]; ok {
		projectType = alias
	}
	if _, err := requiredEnum(&projectType, "project.project_type", projectTypes...); err != nil {
		return ProjectInfo{}, err
	}
	lifecycle, err := requiredEnum(raw.Lifecycle, "project.lifecycle", projectLifecycles...)
	if err != nil {
		return ProjectInfo{}, err
	}
	// The legacy-compatible schema defaults product_tags to an empty list; the
	// v2 minimum of three is asserted separately by assertProductTags.
	tags := []ProductTag{}
	if raw.ProductTags != nil {
		if len(*raw.ProductTags) > 5 {
			return ProjectInfo{}, artifactErrorf("project.product_tags must contain at most 5 entries")
		}
		for index := range *raw.ProductTags {
			tag, err := parseProductTag(&(*raw.ProductTags)[index], fmt.Sprintf("project.product_tags[%d]", index))
			if err != nil {
				return ProjectInfo{}, err
			}
			tags = append(tags, tag)
		}
	}
	return ProjectInfo{
		Name:          name,
		Summary:       summary,
		TargetUsers:   targetUsers,
		PainStatement: painStatement,
		ProjectType:   projectType,
		Lifecycle:     lifecycle,
		ProductTags:   tags,
	}, nil
}

// parseRisk mirrors the risk preprocess: summary wins, then description, then
// title; a risk without any usable text is invalid.
func parseRisk(raw json.RawMessage, field string) (ProjectRisk, error) {
	var risk rawRisk
	if err := json.Unmarshal(raw, &risk); err != nil {
		return ProjectRisk{}, artifactErrorf("%s must be an object", field)
	}
	summary := risk.Summary
	if summary == nil {
		summary = risk.Description
	}
	if summary == nil {
		summary = risk.Title
	}
	parsedSummary, err := requiredTrimmedString(summary, field+".summary", 1, 2_000)
	if err != nil {
		return ProjectRisk{}, err
	}
	severity, err := requiredEnum(risk.Severity, field+".severity", riskSeverities...)
	if err != nil {
		return ProjectRisk{}, err
	}
	category, err := requiredEnum(risk.Category, field+".category", riskCategories...)
	if err != nil {
		return ProjectRisk{}, err
	}
	evidenceIDs, err := requiredEvidenceIDs(risk.EvidenceIDs, field+".evidence_ids", 0, 30)
	if err != nil {
		return ProjectRisk{}, err
	}
	return ProjectRisk{Severity: severity, Category: category, Summary: parsedSummary, EvidenceIDs: evidenceIDs}, nil
}

func parseCommunityStrength(raw *rawCommunityStrength) (ProjectCommunityStrength, error) {
	if raw == nil {
		return ProjectCommunityStrength{}, artifactErrorf("community_strength is required")
	}
	score, err := requiredArtifactFloat(raw.Score, "community_strength.score", 0, 100)
	if err != nil {
		return ProjectCommunityStrength{}, err
	}
	rationale, err := requiredTrimmedString(raw.Rationale, "community_strength.rationale", 1, 2_000)
	if err != nil {
		return ProjectCommunityStrength{}, err
	}
	evidenceIDs, err := requiredEvidenceIDs(raw.EvidenceIDs, "community_strength.evidence_ids", 0, 30)
	if err != nil {
		return ProjectCommunityStrength{}, err
	}
	return ProjectCommunityStrength{Score: score, Rationale: rationale, EvidenceIDs: evidenceIDs}, nil
}

func parseExposure(raw *rawExposure) (ProjectExposure, error) {
	if raw == nil {
		return ProjectExposure{}, artifactErrorf("exposure is required")
	}
	band, err := requiredEnum(raw.Band, "exposure.band", exposureBands...)
	if err != nil {
		return ProjectExposure{}, err
	}
	stars, err := optionalNullableArtifactInt(raw.Stars, "exposure.stars")
	if err != nil {
		return ProjectExposure{}, err
	}
	dependents, err := optionalNullableArtifactInt(raw.Dependents, "exposure.dependents")
	if err != nil {
		return ProjectExposure{}, err
	}
	downloads, err := optionalNullableArtifactInt(raw.Downloads, "exposure.downloads")
	if err != nil {
		return ProjectExposure{}, err
	}
	rationale, err := requiredTrimmedString(raw.Rationale, "exposure.rationale", 1, 2_000)
	if err != nil {
		return ProjectExposure{}, err
	}
	evidenceIDs, err := requiredEvidenceIDs(raw.EvidenceIDs, "exposure.evidence_ids", 0, 30)
	if err != nil {
		return ProjectExposure{}, err
	}
	return ProjectExposure{
		Band:        band,
		Stars:       stars,
		Dependents:  dependents,
		Downloads:   downloads,
		Rationale:   rationale,
		EvidenceIDs: evidenceIDs,
	}, nil
}

// parseProjectAnalysisArtifact validates one analysis artifact exactly like
// projectAnalysisArtifactSchema (the legacy-compatible schema).
func parseProjectAnalysisArtifact(raw string) (*ProjectAnalysisArtifact, error) {
	var artifact rawAnalysisArtifact
	if err := json.Unmarshal([]byte(raw), &artifact); err != nil {
		return nil, artifactErrorf("analysis artifact is not valid JSON")
	}
	schemaVersion, err := parseSchemaVersion(artifact.SchemaVersion)
	if err != nil {
		return nil, err
	}
	analysisID, err := requiredTrimmedString(artifact.AnalysisID, "analysis_id", 1, 100)
	if err != nil {
		return nil, err
	}
	if artifact.Repository == nil {
		return nil, artifactErrorf("repository is required")
	}
	repoKey, err := requiredTrimmedString(artifact.Repository.RepoKey, "repository.repo_key", 3, 140)
	if err != nil {
		return nil, err
	}
	canonicalURL, err := requiredTrimmedString(artifact.Repository.CanonicalURL, "repository.canonical_url", 1, 500)
	if err != nil {
		return nil, err
	}
	if parsed, err := url.Parse(canonicalURL); err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, artifactErrorf("repository.canonical_url must be an absolute URL")
	}
	var requestedRef *string
	if artifact.Repository.RequestedRef != nil {
		ref, err := requiredTrimmedString(artifact.Repository.RequestedRef, "repository.requested_ref", 1, 200)
		if err != nil {
			return nil, err
		}
		requestedRef = &ref
	}
	if artifact.Repository.ResolvedCommitSHA == nil ||
		!resolvedCommitSHAPattern.MatchString(*artifact.Repository.ResolvedCommitSHA) {
		return nil, artifactErrorf("repository.resolved_commit_sha must be a 40-character hex SHA")
	}
	rubricVersion, err := requiredTrimmedString(artifact.RubricVersion, "rubric_version", 1, 100)
	if err != nil {
		return nil, err
	}
	agentVersion, err := requiredTrimmedString(artifact.AgentVersion, "agent_version", 1, 100)
	if err != nil {
		return nil, err
	}
	skillVersion, err := requiredTrimmedString(artifact.SkillVersion, "skill_version", 1, 100)
	if err != nil {
		return nil, err
	}
	project, err := parseProject(artifact.Project)
	if err != nil {
		return nil, err
	}
	if artifact.Scores == nil {
		return nil, artifactErrorf("scores is required")
	}
	pain, err := parseScoreDimension(artifact.Scores.Pain, "scores.pain", 25)
	if err != nil {
		return nil, err
	}
	effectiveness, err := parseScoreDimension(artifact.Scores.Effectiveness, "scores.effectiveness", 30)
	if err != nil {
		return nil, err
	}
	experience, err := parseScoreDimension(artifact.Scores.Experience, "scores.experience", 30)
	if err != nil {
		return nil, err
	}
	valueDensity, err := parseScoreDimension(artifact.Scores.ValueDensity, "scores.value_density", 15)
	if err != nil {
		return nil, err
	}
	productScore, err := requiredArtifactInt(artifact.Scores.ProductScore, "scores.product_score", 0, 100)
	if err != nil {
		return nil, err
	}
	confidence, err := requiredArtifactFloat(artifact.Confidence, "confidence", 0, 100)
	if err != nil {
		return nil, err
	}
	verificationLevel, err := requiredEnum(artifact.VerificationLevel, "verification_level", verificationLevels...)
	if err != nil {
		return nil, err
	}
	unknowns, err := requiredTrimmedStringArray(artifact.Unknowns, "unknowns", 0, 50, 2_000)
	if err != nil {
		return nil, err
	}
	if artifact.Risks == nil {
		return nil, artifactErrorf("risks is required")
	}
	if len(*artifact.Risks) > 50 {
		return nil, artifactErrorf("risks must contain at most 50 entries")
	}
	risks := make([]ProjectRisk, 0, len(*artifact.Risks))
	for index, rawRiskEntry := range *artifact.Risks {
		risk, err := parseRisk(rawRiskEntry, fmt.Sprintf("risks[%d]", index))
		if err != nil {
			return nil, err
		}
		risks = append(risks, risk)
	}
	communityStrength, err := parseCommunityStrength(artifact.CommunityStrength)
	if err != nil {
		return nil, err
	}
	exposure, err := parseExposure(artifact.Exposure)
	if err != nil {
		return nil, err
	}
	analyzedAt, err := requiredTrimmedString(artifact.AnalyzedAt, "analyzed_at", 1, 100)
	if err != nil {
		return nil, err
	}
	if _, err := time.Parse(time.RFC3339Nano, analyzedAt); err != nil {
		return nil, artifactErrorf("analyzed_at must be an ISO 8601 datetime with offset")
	}
	return &ProjectAnalysisArtifact{
		SchemaVersion: schemaVersion,
		AnalysisID:    analysisID,
		Repository: ProjectAnalysisRepository{
			RepoKey:           repoKey,
			CanonicalURL:      canonicalURL,
			RequestedRef:      requestedRef,
			ResolvedCommitSHA: *artifact.Repository.ResolvedCommitSHA,
		},
		RubricVersion: rubricVersion,
		AgentVersion:  agentVersion,
		SkillVersion:  skillVersion,
		Project:       project,
		Scores: ProjectAnalysisScores{
			Pain:          pain,
			Effectiveness: effectiveness,
			Experience:    experience,
			ValueDensity:  valueDensity,
			ProductScore:  productScore,
		},
		Confidence:        confidence,
		VerificationLevel: verificationLevel,
		Unknowns:          unknowns,
		Risks:             risks,
		CommunityStrength: communityStrength,
		Exposure:          exposure,
		AnalyzedAt:        analyzedAt,
	}, nil
}

// parseRuntimeEvidenceArtifact validates one evidence artifact exactly like
// runtimeEvidenceArtifactSchema.
func parseRuntimeEvidenceArtifact(raw string) (*RuntimeEvidenceArtifact, error) {
	var artifact rawEvidenceArtifact
	if err := json.Unmarshal([]byte(raw), &artifact); err != nil {
		return nil, artifactErrorf("evidence artifact is not valid JSON")
	}
	schemaVersion, err := parseSchemaVersion(artifact.SchemaVersion)
	if err != nil {
		return nil, err
	}
	analysisID, err := requiredTrimmedString(artifact.AnalysisID, "analysis_id", 1, 100)
	if err != nil {
		return nil, err
	}
	repoKey, err := requiredTrimmedString(artifact.RepoKey, "repo_key", 3, 140)
	if err != nil {
		return nil, err
	}
	if artifact.ResolvedCommitSHA == nil ||
		!resolvedCommitSHAPattern.MatchString(*artifact.ResolvedCommitSHA) {
		return nil, artifactErrorf("resolved_commit_sha must be a 40-character hex SHA")
	}
	if artifact.Entries == nil {
		return nil, artifactErrorf("entries is required")
	}
	if len(*artifact.Entries) < 1 || len(*artifact.Entries) > 500 {
		return nil, artifactErrorf("entries must contain between 1 and 500 entries")
	}
	entries := make([]RuntimeEvidenceEntry, 0, len(*artifact.Entries))
	for index := range *artifact.Entries {
		raw := &(*artifact.Entries)[index]
		field := fmt.Sprintf("entries[%d]", index)
		id, err := requiredTrimmedString(raw.ID, field+".id", 1, 100)
		if err != nil {
			return nil, err
		}
		kind, err := requiredEnum(raw.Kind, field+".kind", evidenceKinds...)
		if err != nil {
			return nil, err
		}
		summary, err := requiredTrimmedString(raw.Summary, field+".summary", 1, 2_000)
		if err != nil {
			return nil, err
		}
		outcome, err := requiredEnum(raw.Outcome, field+".outcome", evidenceOutcomes...)
		if err != nil {
			return nil, err
		}
		entry := RuntimeEvidenceEntry{ID: id, Kind: kind, Summary: summary, Outcome: outcome}
		if raw.Command != nil {
			command, err := requiredTrimmedString(raw.Command, field+".command", 1, 2_000)
			if err != nil {
				return nil, err
			}
			entry.Command = command
		}
		if raw.Path != nil {
			path, err := requiredTrimmedString(raw.Path, field+".path", 1, 1_000)
			if err != nil {
				return nil, err
			}
			entry.Path = path
		}
		if raw.ExitCode != nil {
			exitCode, err := requiredArtifactInt(raw.ExitCode, field+".exit_code", math.MinInt64, math.MaxInt64)
			if err != nil {
				return nil, err
			}
			entry.ExitCode = &exitCode
		}
		if raw.Excerpt != nil {
			excerpt, err := requiredTrimmedString(raw.Excerpt, field+".excerpt", 1, 4_000)
			if err != nil {
				return nil, err
			}
			entry.Excerpt = excerpt
		}
		entries = append(entries, entry)
	}
	return &RuntimeEvidenceArtifact{
		SchemaVersion:     schemaVersion,
		AnalysisID:        analysisID,
		RepoKey:           repoKey,
		ResolvedCommitSHA: *artifact.ResolvedCommitSHA,
		Entries:           entries,
	}, nil
}

// Internal classification slugs must never surface as public product tags.
var internalProductTags = map[string]bool{
	"micro-tool":         true,
	"sdk-library":        true,
	"web-app":            true,
	"desktop-app":        true,
	"framework-platform": true,
	"database-infra":     true,
	"template-scaffold":  true,
	"enterprise-system":  true,
	"active-evolution":   true,
	"stable-maintenance": true,
	"feature-complete":   true,
	"experimental":       true,
	"abandoned":          true,
	"metadata-only":      true,
	"source-inspected":   true,
	"built":              true,
	"core-flow-executed": true,
}

// Generic labels carry no information and are rejected, case-insensitively.
var genericProductTagLabels = map[string]bool{
	"开源":                  true,
	"开源项目":                true,
	"工具":                  true,
	"实用工具":                true,
	"高质量":                 true,
	"open source":         true,
	"open-source":         true,
	"open-source project": true,
	"project":             true,
	"tool":                true,
	"useful tool":         true,
	"high quality":        true,
}

func assertProductTags(analysis *ProjectAnalysisArtifact) error {
	if analysis.SchemaVersion == ProjectAnalysisSchemaVersion && len(analysis.Project.ProductTags) < 3 {
		return artifactErrorf("Current project analysis requires at least three product tags")
	}
	slugs := map[string]bool{}
	zhLabels := map[string]bool{}
	enLabels := map[string]bool{}
	for _, tag := range analysis.Project.ProductTags {
		if slugs[tag.Slug] {
			return artifactErrorf("Duplicate product tag slug: %s", tag.Slug)
		}
		slugs[tag.Slug] = true
		if internalProductTags[tag.Slug] {
			return artifactErrorf("Product tag exposes an internal classification: %s", tag.Slug)
		}
		for _, label := range []struct {
			value string
			seen  map[string]bool
		}{
			{tag.Labels.Zh, zhLabels},
			{tag.Labels.En, enLabels},
		} {
			normalized := strings.ToLower(strings.TrimSpace(label.value))
			if label.seen[normalized] {
				return artifactErrorf("Duplicate product tag label: %s", label.value)
			}
			label.seen[normalized] = true
			if genericProductTagLabels[normalized] {
				return artifactErrorf("Product tag is too generic: %s", label.value)
			}
		}
	}
	return nil
}

func assertEvidenceReferences(analysis *ProjectAnalysisArtifact, evidence *RuntimeEvidenceArtifact) error {
	available := make(map[string]bool, len(evidence.Entries))
	for _, entry := range evidence.Entries {
		available[entry.ID] = true
	}
	referenced := []string{}
	referenced = append(referenced, analysis.Scores.Pain.EvidenceIDs...)
	referenced = append(referenced, analysis.Scores.Effectiveness.EvidenceIDs...)
	referenced = append(referenced, analysis.Scores.Experience.EvidenceIDs...)
	referenced = append(referenced, analysis.Scores.ValueDensity.EvidenceIDs...)
	referenced = append(referenced, analysis.CommunityStrength.EvidenceIDs...)
	referenced = append(referenced, analysis.Exposure.EvidenceIDs...)
	for _, risk := range analysis.Risks {
		referenced = append(referenced, risk.EvidenceIDs...)
	}
	for _, tag := range analysis.Project.ProductTags {
		referenced = append(referenced, tag.EvidenceIDs...)
	}
	seen := map[string]bool{}
	missing := []string{}
	for _, id := range referenced {
		if !available[id] && !seen[id] {
			seen[id] = true
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		return artifactErrorf("Missing evidence references: %s", strings.Join(missing, ", "))
	}
	return nil
}

// ParseProjectAnalysisArtifacts mirrors parseProjectAnalysisArtifacts: both
// artifacts are validated, their identities are cross-checked, the product
// score must equal the dimension sum, and every referenced evidence id must
// exist. All failures wrap ErrArtifactInvalid.
func ParseProjectAnalysisArtifacts(input ProjectAnalysisArtifactsInput) (*ParsedProjectAnalysisArtifacts, error) {
	if utf8.RuneCountInString(input.AnalysisRaw) > projectAnalysisArtifactMaxLength {
		return nil, artifactErrorf("analysis artifact is too large")
	}
	if utf8.RuneCountInString(input.EvidenceRaw) > projectEvidenceArtifactMaxLength {
		return nil, artifactErrorf("evidence artifact is too large")
	}
	if strings.TrimSpace(input.ReportMarkdown) == "" || utf8.RuneCountInString(input.ReportMarkdown) > projectReportMaxLength {
		return nil, artifactErrorf("report artifact is empty or too large")
	}

	analysis, err := parseProjectAnalysisArtifact(input.AnalysisRaw)
	if err != nil {
		return nil, err
	}
	evidence, err := parseRuntimeEvidenceArtifact(input.EvidenceRaw)
	if err != nil {
		return nil, err
	}

	expectedRepoKey := strings.ToLower(input.ExpectedRepoKey)
	if analysis.AnalysisID != input.ExpectedAnalysisID || evidence.AnalysisID != input.ExpectedAnalysisID {
		return nil, artifactErrorf("analysis identity mismatch")
	}
	if strings.ToLower(analysis.Repository.RepoKey) != expectedRepoKey ||
		strings.ToLower(evidence.RepoKey) != expectedRepoKey {
		return nil, artifactErrorf("repository identity mismatch")
	}
	if analysis.Repository.ResolvedCommitSHA != evidence.ResolvedCommitSHA {
		return nil, artifactErrorf("resolved commit mismatch")
	}
	if analysis.SchemaVersion != evidence.SchemaVersion {
		return nil, artifactErrorf("artifact schema version mismatch")
	}

	dimensionSum := analysis.Scores.Pain.Score + analysis.Scores.Effectiveness.Score +
		analysis.Scores.Experience.Score + analysis.Scores.ValueDensity.Score
	if dimensionSum != analysis.Scores.ProductScore {
		return nil, artifactErrorf("Product score must equal the dimension sum")
	}
	if err := assertProductTags(analysis); err != nil {
		return nil, err
	}
	if err := assertEvidenceReferences(analysis, evidence); err != nil {
		return nil, err
	}

	if run := input.ExpectedRun; run != nil {
		sameRef := (run.RequestedRef == nil) == (analysis.Repository.RequestedRef == nil)
		if sameRef && run.RequestedRef != nil {
			sameRef = *run.RequestedRef == *analysis.Repository.RequestedRef
		}
		if analysis.RubricVersion != run.RubricVersion ||
			analysis.AgentVersion != run.AgentVersion ||
			analysis.SkillVersion != run.SkillVersion ||
			!sameRef {
			return nil, artifactErrorf("Artifact version or requested ref does not match the analysis run.")
		}
	}

	return &ParsedProjectAnalysisArtifacts{
		Analysis:       analysis,
		Evidence:       evidence,
		ReportMarkdown: input.ReportMarkdown,
	}, nil
}

type BoardBlockingReason = string

const (
	BlockingProductScoreBelowTreasureThreshold BoardBlockingReason = "product_score_below_treasure_threshold"
	BlockingConfidenceBelowTreasureThreshold   BoardBlockingReason = "confidence_below_treasure_threshold"
	BlockingVerificationBelowTreasureThreshold BoardBlockingReason = "verification_below_treasure_threshold"
	BlockingExposureNotTreasureEligible        BoardBlockingReason = "exposure_not_treasure_eligible"
	BlockingCriticalAdoptionRisk               BoardBlockingReason = "critical_adoption_risk"
)

type ProjectBoardEligibility struct {
	TreasureEligible bool
	ClassicEligible  bool
	BlockingReasons  []BoardBlockingReason
}

var verificationRank = map[string]int{
	"metadata_only":      0,
	"source_inspected":   1,
	"built":              2,
	"core_flow_executed": 3,
}

// DeriveProjectBoardEligibility mirrors deriveProjectBoardEligibility in
// src/lib/project-ranking.ts, including the blocking-reason order.
func DeriveProjectBoardEligibility(analysis *ProjectAnalysisArtifact) ProjectBoardEligibility {
	blockingReasons := []BoardBlockingReason{}
	criticalRisk := false
	for _, risk := range analysis.Risks {
		if risk.Severity == "critical" {
			criticalRisk = true
			break
		}
	}
	if criticalRisk {
		blockingReasons = append(blockingReasons, BlockingCriticalAdoptionRisk)
	}
	if analysis.Scores.ProductScore < 60 {
		blockingReasons = append(blockingReasons, BlockingProductScoreBelowTreasureThreshold)
	}
	if analysis.Confidence < 60 {
		blockingReasons = append(blockingReasons, BlockingConfidenceBelowTreasureThreshold)
	}
	if verificationRank[analysis.VerificationLevel] < verificationRank["source_inspected"] {
		blockingReasons = append(blockingReasons, BlockingVerificationBelowTreasureThreshold)
	}
	if analysis.Exposure.Band != "low" && analysis.Exposure.Band != "emerging" {
		blockingReasons = append(blockingReasons, BlockingExposureNotTreasureEligible)
	}

	treasureEligible := len(blockingReasons) == 0
	classicLifecycle := analysis.Project.Lifecycle == "active_evolution" ||
		analysis.Project.Lifecycle == "stable_maintenance" ||
		analysis.Project.Lifecycle == "feature_complete"
	classicExposure := analysis.Exposure.Band == "established" || analysis.Exposure.Band == "mainstream"
	classicEligible := !criticalRisk &&
		analysis.Scores.ProductScore >= 60 &&
		analysis.Confidence >= 70 &&
		classicLifecycle &&
		classicExposure

	return ProjectBoardEligibility{
		TreasureEligible: treasureEligible,
		ClassicEligible:  classicEligible,
		BlockingReasons:  blockingReasons,
	}
}
