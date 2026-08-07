package backend

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	vsMinimumScore       = 55
	verdictGatewayMaxAge = 90 * time.Second
	verdictLLMTimeout    = 100 * time.Second
)

const verdictControlLineTemplate = `(?s)@@%s\s*(.*?)@@`

// MatchupStore writes the existing vs_matchups table. It deliberately makes no
// schema changes: the deterministic base row and the generated verdict remain
// exactly the same records the Next route used before extraction.
type MatchupStore interface {
	RecordMatchup(context.Context, MatchupInput) error
	BumpMatchupView(context.Context, string, string) error
}

type MatchupInput struct {
	A       string
	B       string
	Winner  *string
	Bucket  string
	Gap     float64
	ScoreA  float64
	ScoreB  float64
	Verdict *RoastLine
	Advice  *RoastLine
	Source  *string
}

func (s *TursoStore) RecordMatchup(ctx context.Context, matchup MatchupInput) error {
	var verdict, advice, source any
	if matchup.Verdict != nil {
		encoded, err := json.Marshal(matchup.Verdict)
		if err != nil {
			return fmt.Errorf("marshal matchup verdict: %w", err)
		}
		verdict = string(encoded)
	}
	if matchup.Advice != nil {
		encoded, err := json.Marshal(matchup.Advice)
		if err != nil {
			return fmt.Errorf("marshal matchup advice: %w", err)
		}
		advice = string(encoded)
	}
	if matchup.Source != nil {
		source = *matchup.Source
	}
	now := time.Now().UnixMilli()
	_, err := s.db.ExecContext(ctx, `INSERT INTO vs_matchups
      (handle_a, handle_b, winner, bucket, gap, score_a, score_b, verdict, advice, verdict_source, view_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(handle_a, handle_b) DO UPDATE SET
      winner         = excluded.winner,
      bucket         = excluded.bucket,
      gap            = excluded.gap,
      score_a        = excluded.score_a,
      score_b        = excluded.score_b,
      verdict        = COALESCE(excluded.verdict, vs_matchups.verdict),
      advice         = COALESCE(excluded.advice, vs_matchups.advice),
      verdict_source = CASE WHEN excluded.verdict IS NOT NULL
                            THEN excluded.verdict_source ELSE vs_matchups.verdict_source END,
      updated_at     = excluded.updated_at`,
		strings.ToLower(matchup.A), strings.ToLower(matchup.B), matchup.Winner, matchup.Bucket, matchup.Gap,
		matchup.ScoreA, matchup.ScoreB, verdict, advice, source, now, now,
	)
	if err != nil {
		return fmt.Errorf("record matchup: %w", err)
	}
	return nil
}

func (s *TursoStore) BumpMatchupView(ctx context.Context, a, b string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE vs_matchups SET view_count = view_count + 1
    WHERE handle_a = ? AND handle_b = ?`, strings.ToLower(a), strings.ToLower(b))
	if err != nil {
		return fmt.Errorf("bump matchup view: %w", err)
	}
	return nil
}

type verdictDecision struct {
	Bucket           string
	Winner           string
	Gap              float64
	DimensionWinners map[string]string
}

var verdictDimensions = []struct {
	key string
	max float64
}{
	{"account_maturity", 10},
	{"original_project_quality", 18},
	{"contribution_quality", 27},
	{"ecosystem_impact", 20},
	{"community_influence", 8},
	{"activity_authenticity", 17},
}

func verdictFor(a, b StoredScoreDetail) verdictDecision {
	gap := math.Abs(a.FinalScore - b.FinalScore)
	bucket := "even"
	if gap >= 15 {
		bucket = "crush"
	} else if gap >= 4 {
		bucket = "edge"
	}
	winner := "tie"
	if gap >= 0.005 {
		if a.FinalScore > b.FinalScore {
			winner = "a"
		} else {
			winner = "b"
		}
	}
	dimensions := map[string]string{}
	for _, dimension := range verdictDimensions {
		av, bv := verdictSubScore(a.SubScores, dimension.key), verdictSubScore(b.SubScores, dimension.key)
		winner := "tie"
		if math.Abs(av-bv) >= 0.005 {
			if av > bv {
				winner = "a"
			} else {
				winner = "b"
			}
		}
		dimensions[dimension.key] = winner
	}
	return verdictDecision{Bucket: bucket, Winner: winner, Gap: gap, DimensionWinners: dimensions}
}

func verdictSubScore(scores SubScores, key string) float64 {
	switch key {
	case "account_maturity":
		return scores.AccountMaturity
	case "original_project_quality":
		return scores.OriginalProjectQuality
	case "contribution_quality":
		return scores.ContributionQuality
	case "ecosystem_impact":
		return scores.EcosystemImpact
	case "community_influence":
		return scores.CommunityInfluence
	case "activity_authenticity":
		return scores.ActivityAuthenticity
	default:
		return 0
	}
}

type verdictRequest struct {
	A unknownString `json:"a"`
	B unknownString `json:"b"`
}

type verdictGatewayRequest struct {
	Timestamp string
	Principal string
}

// verifyVerdictGatewayRequest admits only the tiny Vercel BotID gateway. The
// HMAC covers the raw JSON payload as well as the timestamp and verified client
// identity, so callers cannot bypass BotID by calling Railway directly or forge
// a different rate-limit principal with a forwarding header.
func (s *APIServer) verifyVerdictGatewayRequest(request *http.Request, body []byte) (*verdictGatewayRequest, error) {
	if s.config.VerdictGatewaySecret == "" {
		return nil, errors.New("verdict gateway is not configured")
	}
	timestamp := strings.TrimSpace(request.Header.Get("X-Ghfind-Gateway-Timestamp"))
	principal := strings.TrimSpace(request.Header.Get("X-Ghfind-Client-IP"))
	signature := strings.TrimSpace(request.Header.Get("X-Ghfind-Gateway-Signature"))
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || principal == "" || len(principal) > 128 {
		return nil, errors.New("invalid verdict gateway request")
	}
	issuedAt := time.Unix(seconds, 0)
	if age := s.clock().Sub(issuedAt); age > verdictGatewayMaxAge || age < -verdictGatewayMaxAge {
		return nil, errors.New("expired verdict gateway request")
	}
	payload := timestamp + "\n" + principal + "\n" + string(body)
	mac := hmac.New(sha256.New, []byte(s.config.VerdictGatewaySecret))
	_, _ = mac.Write([]byte(payload))
	expected := mac.Sum(nil)
	presented, err := hex.DecodeString(signature)
	if err != nil || subtle.ConstantTimeCompare(presented, expected) != 1 {
		return nil, errors.New("invalid verdict gateway signature")
	}
	return &verdictGatewayRequest{Timestamp: timestamp, Principal: principal}, nil
}

func (s *APIServer) vsVerdict(w http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(io.LimitReader(request.Body, 64<<10))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, nil)
		return
	}
	gateway, err := s.verifyVerdictGatewayRequest(request, body)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "gateway_unauthorized"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	var input verdictRequest
	if err := json.Unmarshal(body, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, nil)
		return
	}
	a, b := normalizeGitHubUsername(input.A.String()), normalizeGitHubUsername(input.B.String())
	if a == "" || b == "" || a == b {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_pair"}, nil)
		return
	}
	if a > b {
		a, b = b, a
	}
	now := s.clock().UTC()
	if s.verdictLimiter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"verdict": nil, "reason": "rate_limit_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": strconv.Itoa(rateLimitUnavailableRetry)})
		return
	}
	limit, err := s.verdictLimiter.LimitVerdict(request.Context(), gateway.Principal, now)
	if err != nil {
		limit.Unavailable = true
	}
	if limit.Unavailable {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"verdict": nil, "reason": "rate_limit_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": strconv.Itoa(rateLimitUnavailableRetry)})
		return
	}
	if !limit.Success {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"verdict": nil, "reason": "rate_limited"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	if s.scoreReads == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"verdict": nil, "reason": "failed"}, nil)
		return
	}
	var first, second *StoredScoreDetail
	var firstErr, secondErr error
	var wait sync.WaitGroup
	wait.Add(2)
	go func() { defer wait.Done(); first, firstErr = s.scoreReads.GetStoredScore(request.Context(), a) }()
	go func() { defer wait.Done(); second, secondErr = s.scoreReads.GetStoredScore(request.Context(), b) }()
	wait.Wait()
	if firstErr != nil || secondErr != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"verdict": nil, "reason": "failed"}, nil)
		return
	}
	if first == nil || second == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "need_both", "verdict": nil}, nil)
		return
	}
	decision := verdictFor(*first, *second)
	winner := (*string)(nil)
	if decision.Winner == "a" {
		winner = &first.Username
	} else if decision.Winner == "b" {
		winner = &second.Username
	}
	if first.FinalScore < vsMinimumScore || second.FinalScore < vsMinimumScore {
		writeJSON(w, http.StatusOK, map[string]any{"verdict": nil, "reason": "below_floor"}, nil)
		return
	}
	base := MatchupInput{A: a, B: b, Winner: winner, Bucket: decision.Bucket, Gap: decision.Gap, ScoreA: first.FinalScore, ScoreB: second.FinalScore}
	if s.matchups != nil {
		template := "template"
		base.Source = &template
		_ = s.matchups.RecordMatchup(request.Context(), base)
		_ = s.matchups.BumpMatchupView(request.Context(), a, b)
	}
	if s.verdictCache != nil {
		if cached, err := s.verdictCache.GetCachedVerdict(request.Context(), a, b); err == nil && cached != nil {
			s.writeVerdictSuccess(w, *cached)
			return
		}
	}
	configs := s.config.DefaultLLMConfigs()
	if len(configs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"verdict": nil, "reason": "no_llm"}, nil)
		return
	}
	leader := true
	if s.verdictCache != nil {
		leader, _ = s.verdictCache.TryAcquireVerdictLock(request.Context(), a, b)
		if !leader {
			if waited := s.waitForVerdict(request.Context(), a, b); waited != nil {
				s.writeVerdictSuccess(w, *waited)
				return
			}
		}
	}
	if leader && s.verdictCache != nil {
		defer func() { _ = s.verdictCache.ReleaseVerdictLock(request.Context(), a, b) }()
	}
	raw, err := CompleteLLM(request.Context(), s.llmHTTPClient, configs, buildPKVerdictMessages(*first, *second, decision), 0.6, now.Add(verdictLLMTimeout))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"verdict": nil, "reason": "failed"}, nil)
		return
	}
	verdictLine, advice := parsePKVerdict(raw)
	if verdictLine.ZH == "" && verdictLine.EN == "" {
		writeJSON(w, http.StatusOK, map[string]any{"verdict": nil, "reason": "empty"}, nil)
		return
	}
	value := CachedVerdict{Verdict: verdictLine, Advice: advice, Winner: winner, Bucket: decision.Bucket}
	if s.verdictCache != nil {
		_ = s.verdictCache.SetCachedVerdict(request.Context(), a, b, value)
	}
	if s.matchups != nil {
		llm := "llm"
		base.Verdict, base.Advice, base.Source = &verdictLine, &advice, &llm
		_ = s.matchups.RecordMatchup(request.Context(), base)
	}
	s.writeVerdictSuccess(w, value)
}

func (s *APIServer) waitForVerdict(ctx context.Context, a, b string) *CachedVerdict {
	if s.verdictCache == nil {
		return nil
	}
	deadline := s.clock().Add(s.verdictWait)
	for s.clock().Before(deadline) {
		timer := time.NewTimer(s.verdictPoll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if cached, err := s.verdictCache.GetCachedVerdict(ctx, a, b); err == nil && cached != nil {
			return cached
		}
		locked, err := s.verdictCache.HasVerdictLock(ctx, a, b)
		if err == nil && !locked {
			cached, _ := s.verdictCache.GetCachedVerdict(ctx, a, b)
			return cached
		}
	}
	return nil
}

func (s *APIServer) writeVerdictSuccess(w http.ResponseWriter, value CachedVerdict) {
	writeJSON(w, http.StatusOK, map[string]any{
		"verdict": value.Verdict,
		"advice":  value.Advice,
		"winner":  value.Winner,
		"bucket":  value.Bucket,
	}, nil)
}

const pkSystemPrompt = `你是「GitHub 开发者对决裁判 / 毒舌解说」。给你两名开发者 A、B 的确定性评分数据(总分、段位、六维子分、标签、一句话点评),以及已经算好的胜负 winner / 分差 gap / 档位 bucket(crush=碾压, edge=险胜, even=五五开)。胜负是既定事实,你不要改判。

你的任务:基于数据写**两段**,并且**中英双语**、各自地道(不要机翻腔)。

1) 毒舌裁决(verdict):2-4 句,有梗、嘴臭但**不造谣、不辱骂人身**,只吐槽账号的公开数据与行为。点名双方差距的**具体维度**(如"生态影响力被碾压""原创项目质量拉胯"),让胜负有据可依。
2) 进步建议(advice):面向**落后一方**(五五开则兼顾双方)的**具体、可执行**的自我提升/学习建议 2-3 条。点名最弱的维度,给方向(例如"少灌文档型 PR,多向高星仓库提核心功能 PR""把某个原创项目补上 README/测试/release,做出可用度""持续活跃、把贡献沉淀成可验证的 commit")。不要空话套话、不要客套。

严格输出格式:只输出下面两行控制行,不要任何多余解释、不要 Markdown、不要代码块:
@@VERDICT zh=<中文毒舌裁决>|en=<English savage verdict>@@
@@ADVICE zh=<中文进步建议,可用「1)…2)…」编号>|en=<English advice, may use 1)… 2)…>@@`

func buildPKVerdictMessages(a, b StoredScoreDetail, decision verdictDecision) []LLMMessage {
	side := func(detail StoredScoreDetail) map[string]any {
		dimensions := map[string]string{}
		for _, dimension := range verdictDimensions {
			dimensions[dimension.key] = strconv.FormatFloat(verdictSubScore(detail.SubScores, dimension.key), 'f', 1, 64) + "/" + strconv.FormatFloat(dimension.max, 'f', -1, 64)
		}
		tierEN := map[string]string{"夯": "GOD", "顶级": "ELITE", "人上人": "SOLID", "NPC": "NPC", "拉完了": "TRASH"}[detail.Tier]
		oneLiner := detail.RoastLine.ZH
		if oneLiner == "" {
			oneLiner = detail.RoastLine.EN
		}
		tags := append([]string{}, detail.Tags.ZH...)
		tags = append(tags, detail.Tags.EN...)
		if len(tags) > 6 {
			tags = tags[:6]
		}
		return map[string]any{"handle": detail.Username, "final_score": detail.FinalScore, "tier_zh": detail.Tier, "tier_en": tierEN, "sub_scores": dimensions, "tags": tags, "one_liner": oneLiner}
	}
	winner := "tie"
	if decision.Winner == "a" {
		winner = a.Username
	} else if decision.Winner == "b" {
		winner = b.Username
	}
	payload := map[string]any{
		"a": side(a), "b": side(b),
		"result": map[string]any{"winner": winner, "bucket": decision.Bucket, "gap": math.Round(decision.Gap*100) / 100, "dimension_winners": decision.DimensionWinners},
	}
	encoded, _ := json.MarshalIndent(payload, "", "  ")
	return []LLMMessage{
		{Role: "system", Content: pkSystemPrompt},
		{Role: "user", Content: "这是两名开发者的对决数据(JSON)。请只据此输出 @@VERDICT@@ 与 @@ADVICE@@ 两行:\n\n```json\n" + string(encoded) + "\n```"},
	}
}

func parsePKVerdict(raw string) (RoastLine, RoastLine) {
	return parsePKBilingual(raw, "VERDICT"), parsePKBilingual(raw, "ADVICE")
}

func parsePKBilingual(raw, tag string) RoastLine {
	line := regexp.MustCompile(fmt.Sprintf(verdictControlLineTemplate, regexp.QuoteMeta(tag))).FindStringSubmatch(raw)
	if len(line) != 2 {
		return RoastLine{}
	}
	field := func(key string) string {
		marker := key + "="
		start := strings.Index(line[1], marker)
		if start < 0 {
			return ""
		}
		text := line[1][start+len(marker):]
		if end := strings.Index(text, "|"); end >= 0 {
			text = text[:end]
		}
		text = strings.TrimSpace(text)
		if len([]rune(text)) > 500 {
			text = string([]rune(text)[:500])
		}
		return text
	}
	return RoastLine{ZH: field("zh"), EN: field("en")}
}
