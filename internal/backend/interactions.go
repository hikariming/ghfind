package backend

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const maxFollows = 50

var (
	blogSlugPattern         = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	commentSensitivePattern = regexp.MustCompile(`习近平|毛泽东|习大大|八九六四|天安门|共产党|大大|六四|8964|64|中国|人民|党`)
)

// The content directories are compiled into the Next image, not the Go image.
// Keep this small manifest synchronized with content/blog and content/collections
// so comments cannot be created for an arbitrary filesystem-like slug.
var blogCommentSlugs = map[string]struct{}{
	"how-we-score-github-accounts":    {},
	"we-scored-19000-github-accounts": {},
	"who-builds-dify":                 {},
	"who-builds-openclaw":             {},
}

var collectionCommentSlugs = map[string]struct{}{
	"lofisu":       {},
	"max-liu":      {},
	"yuxuan-zhang": {},
}

// InteractionStore is the durable social-data contract. All methods target
// existing Turso tables; it intentionally has no schema-management method.
type InteractionStore interface {
	ListFollowedAccounts(context.Context, int64, time.Time) ([]FollowedAccount, error)
	IsFollowing(context.Context, int64, string) (bool, error)
	SetFollow(context.Context, int64, string, time.Time) (followWriteResult, error)
	RemoveFollow(context.Context, int64, string) error
	ListProfileComments(context.Context, string) ([]ProfileComment, error)
	CreateProfileComment(context.Context, string, string, CommentAuthor, *int64, time.Time) (*ProfileComment, error)
	ListBlogComments(context.Context, string) ([]BlogComment, error)
	CreateBlogComment(context.Context, string, string, CommentAuthor, *int64, time.Time) (*BlogComment, error)
	GetProfileReactionState(context.Context, string, *int64) (ProfileReactionState, error)
	SetProfileReaction(context.Context, string, int64, string, ProfileReaction, time.Time) (ProfileReactionState, error)
	RemoveProfileReaction(context.Context, string, int64) (ProfileReactionState, error)
}

type CommentAuthor struct {
	Type      string  `json:"type"`
	Username  string  `json:"username,omitempty"`
	AvatarURL *string `json:"avatarUrl"`
}

type ProfileComment struct {
	ID             string        `json:"id"`
	TargetUsername string        `json:"targetUsername"`
	Author         CommentAuthor `json:"author"`
	Text           string        `json:"text"`
	CreatedAt      int64         `json:"createdAt"`
}

type BlogComment struct {
	ID        string        `json:"id"`
	PostSlug  string        `json:"postSlug"`
	Author    CommentAuthor `json:"author"`
	Text      string        `json:"text"`
	CreatedAt int64         `json:"createdAt"`
}

type CollectionComment struct {
	ID             string        `json:"id"`
	CollectionSlug string        `json:"collectionSlug"`
	Author         CommentAuthor `json:"author"`
	Text           string        `json:"text"`
	CreatedAt      int64         `json:"createdAt"`
}

type ProfileReaction string

const (
	ReactionLike   ProfileReaction = "like"
	ReactionPoop   ProfileReaction = "poop"
	ReactionKick   ProfileReaction = "kick"
	ReactionFire   ProfileReaction = "fire"
	ReactionSalute ProfileReaction = "salute"
	ReactionClown  ProfileReaction = "clown"
)

type ProfileReactionCounts struct {
	Like   int `json:"like"`
	Poop   int `json:"poop"`
	Kick   int `json:"kick"`
	Fire   int `json:"fire"`
	Salute int `json:"salute"`
	Clown  int `json:"clown"`
}

type ProfileReactionState struct {
	Counts         ProfileReactionCounts `json:"counts"`
	ViewerReaction *ProfileReaction      `json:"viewerReaction"`
}

type FollowedAccount struct {
	Username    string   `json:"username"`
	DisplayName *string  `json:"display_name"`
	AvatarURL   *string  `json:"avatar_url"`
	FinalScore  *float64 `json:"final_score"`
	Tier        *string  `json:"tier"`
	WeeklyDelta *float64 `json:"weekly_delta"`
	FollowedAt  int64    `json:"followed_at"`
}

type followWriteResult string

const (
	followWriteOK    followWriteResult = "ok"
	followWriteLimit followWriteResult = "limit"
)

func normalizeBlogSlug(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if !blogSlugPattern.MatchString(value) {
		return ""
	}
	return value
}

func normalizeCommentText(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	compact := strings.Join(strings.Fields(text), " ")
	runes := []rune(compact)
	if len(runes) > 80 {
		compact = string(runes[:80])
	}
	return commentSensitivePattern.ReplaceAllStringFunc(compact, func(match string) string {
		return strings.Repeat("*", len([]rune(match)))
	})
}

func validProfileReaction(value string) (ProfileReaction, bool) {
	switch ProfileReaction(value) {
	case ReactionLike, ReactionPoop, ReactionKick, ReactionFire, ReactionSalute, ReactionClown:
		return ProfileReaction(value), true
	default:
		return "", false
	}
}

func emptyProfileReactionCounts() ProfileReactionCounts { return ProfileReactionCounts{} }

func newUUIDv4() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16]), nil
}

func commentAuthor(kind, login string, avatar sql.NullString) CommentAuthor {
	if kind == "github" && login != "" {
		var avatarURL *string
		if avatar.Valid && avatar.String != "" {
			avatarURL = &avatar.String
		}
		return CommentAuthor{Type: "github", Username: login, AvatarURL: avatarURL}
	}
	return CommentAuthor{Type: "anonymous"}
}

func (s *TursoStore) ListProfileComments(ctx context.Context, target string) ([]ProfileComment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, target_username, body, author_kind, author_login, author_avatar_url, created_at
		FROM (
			SELECT rowid AS sort_rowid, id, target_username, body, author_kind, author_login, author_avatar_url, created_at
			FROM profile_comments WHERE target_username = ? AND hidden = 0
			ORDER BY created_at DESC, rowid DESC LIMIT 24
		) ORDER BY created_at ASC, sort_rowid ASC`, target)
	if err != nil {
		return nil, fmt.Errorf("list profile comments: %w", err)
	}
	defer rows.Close()
	comments := make([]ProfileComment, 0)
	for rows.Next() {
		var comment ProfileComment
		var kind string
		var login, avatar sql.NullString
		if err := rows.Scan(&comment.ID, &comment.TargetUsername, &comment.Text, &kind, &login, &avatar, &comment.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan profile comment: %w", err)
		}
		comment.Author = commentAuthor(kind, login.String, avatar)
		comment.Text = maskCommentText(comment.Text)
		comments = append(comments, comment)
	}
	return comments, rows.Err()
}

func (s *TursoStore) CreateProfileComment(ctx context.Context, target, text string, author CommentAuthor, authorID *int64, now time.Time) (*ProfileComment, error) {
	return s.createComment(ctx, "profile_comments", "target_username", target, text, author, authorID, now)
}

func (s *TursoStore) createComment(ctx context.Context, table, targetColumn, target, text string, author CommentAuthor, authorID *int64, now time.Time) (*ProfileComment, error) {
	id, err := newUUIDv4()
	if err != nil {
		return nil, fmt.Errorf("generate comment id: %w", err)
	}
	var login any
	var avatar any
	var githubID any
	if author.Type == "github" {
		login, avatar = author.Username, author.AvatarURL
		if authorID != nil {
			githubID = *authorID
		}
	}
	if _, err := s.db.ExecContext(ctx, fmt.Sprintf(`INSERT INTO %s (id, %s, body, author_kind, author_github_id, author_login, author_avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, table, targetColumn), id, target, text, author.Type, githubID, login, avatar, now.UnixMilli()); err != nil {
		return nil, fmt.Errorf("create comment: %w", err)
	}
	return &ProfileComment{ID: id, TargetUsername: target, Author: author, Text: text, CreatedAt: now.UnixMilli()}, nil
}

func (s *TursoStore) ListBlogComments(ctx context.Context, slug string) ([]BlogComment, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, post_slug, body, author_kind, author_login, author_avatar_url, created_at
		FROM (
			SELECT rowid AS sort_rowid, id, post_slug, body, author_kind, author_login, author_avatar_url, created_at
			FROM blog_comments WHERE post_slug = ? AND hidden = 0
			ORDER BY created_at DESC, rowid DESC LIMIT 24
		) ORDER BY created_at ASC, sort_rowid ASC`, slug)
	if err != nil {
		return nil, fmt.Errorf("list blog comments: %w", err)
	}
	defer rows.Close()
	comments := make([]BlogComment, 0)
	for rows.Next() {
		var comment BlogComment
		var kind string
		var login, avatar sql.NullString
		if err := rows.Scan(&comment.ID, &comment.PostSlug, &comment.Text, &kind, &login, &avatar, &comment.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan blog comment: %w", err)
		}
		comment.Author = commentAuthor(kind, login.String, avatar)
		comment.Text = maskCommentText(comment.Text)
		comments = append(comments, comment)
	}
	return comments, rows.Err()
}

func (s *TursoStore) CreateBlogComment(ctx context.Context, slug, text string, author CommentAuthor, authorID *int64, now time.Time) (*BlogComment, error) {
	comment, err := s.createComment(ctx, "blog_comments", "post_slug", slug, text, author, authorID, now)
	if err != nil {
		return nil, err
	}
	return &BlogComment{ID: comment.ID, PostSlug: slug, Author: author, Text: text, CreatedAt: comment.CreatedAt}, nil
}

func maskCommentText(text string) string {
	return commentSensitivePattern.ReplaceAllStringFunc(text, func(match string) string {
		return strings.Repeat("*", len([]rune(match)))
	})
}

func (s *TursoStore) IsFollowing(ctx context.Context, githubID int64, target string) (bool, error) {
	var found int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM follows WHERE follower_github_id = ? AND target_username = ? LIMIT 1`, githubID, target).Scan(&found)
	if err == nil {
		return true, nil
	}
	if err == sql.ErrNoRows {
		return false, nil
	}
	return false, fmt.Errorf("read follow: %w", err)
}

func (s *TursoStore) SetFollow(ctx context.Context, githubID int64, target string, now time.Time) (followWriteResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin follow transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM follows WHERE follower_github_id = ?`, githubID).Scan(&count); err != nil {
		return "", fmt.Errorf("count follows: %w", err)
	}
	var existing int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM follows WHERE follower_github_id = ? AND target_username = ? LIMIT 1`, githubID, target).Scan(&existing)
	if err != nil && err != sql.ErrNoRows {
		return "", fmt.Errorf("read existing follow: %w", err)
	}
	if err == sql.ErrNoRows && count >= maxFollows {
		return followWriteLimit, nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO follows (follower_github_id, target_username, created_at) VALUES (?, ?, ?) ON CONFLICT (follower_github_id, target_username) DO NOTHING`, githubID, target, now.UnixMilli()); err != nil {
		return "", fmt.Errorf("set follow: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit follow: %w", err)
	}
	return followWriteOK, nil
}

func (s *TursoStore) RemoveFollow(ctx context.Context, githubID int64, target string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM follows WHERE follower_github_id = ? AND target_username = ?`, githubID, target)
	if err != nil {
		return fmt.Errorf("remove follow: %w", err)
	}
	return nil
}

func (s *TursoStore) ListFollowedAccounts(ctx context.Context, githubID int64, now time.Time) ([]FollowedAccount, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT f.target_username, f.created_at, s.display_name, s.avatar_url, s.final_score, s.tier, s.prev_score, s.prev_scanned_at
		FROM follows f LEFT JOIN scores s ON s.username = f.target_username AND s.hidden = 0 AND s.score_version = ?
		WHERE f.follower_github_id = ? ORDER BY f.created_at DESC LIMIT ?`, canonicalScoreVersion, githubID, maxFollows)
	if err != nil {
		return nil, fmt.Errorf("list follows: %w", err)
	}
	defer rows.Close()
	type followRow struct {
		account              FollowedAccount
		previous, previousAt sql.NullFloat64
		previousAtInt        sql.NullInt64
	}
	result := make([]followRow, 0)
	names := make([]string, 0)
	for rows.Next() {
		var row followRow
		var score sql.NullFloat64
		var tier sql.NullString
		if err := rows.Scan(&row.account.Username, &row.account.FollowedAt, &row.account.DisplayName, &row.account.AvatarURL, &score, &tier, &row.previous, &row.previousAtInt); err != nil {
			return nil, fmt.Errorf("scan follow: %w", err)
		}
		if score.Valid {
			row.account.FinalScore = &score.Float64
			names = append(names, row.account.Username)
		}
		if tier.Valid {
			row.account.Tier = &tier.String
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	baselines, err := s.weeklyBaselines(ctx, names, now)
	if err != nil {
		return nil, err
	}
	accounts := make([]FollowedAccount, 0, len(result))
	cutoff := now.Add(-7 * 24 * time.Hour).UnixMilli()
	for _, row := range result {
		if row.account.FinalScore != nil {
			baseline, hasBaseline := baselines[row.account.Username]
			if !hasBaseline && row.previous.Valid && row.previousAtInt.Valid && row.previousAtInt.Int64 <= cutoff {
				baseline, hasBaseline = row.previous.Float64, true
			}
			if hasBaseline {
				delta := *row.account.FinalScore - baseline
				if math.Abs(delta) >= 0.05 {
					row.account.WeeklyDelta = &delta
				}
			}
		}
		accounts = append(accounts, row.account)
	}
	return accounts, nil
}

func (s *TursoStore) weeklyBaselines(ctx context.Context, names []string, now time.Time) (map[string]float64, error) {
	baselines := make(map[string]float64)
	if len(names) == 0 {
		return baselines, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(names)), ",")
	args := make([]any, 0, len(names)+1)
	args = append(args, now.Add(-7*24*time.Hour).UnixMilli())
	for _, name := range names {
		args = append(args, name)
	}
	query := `SELECT s.username, MAX(s.final_score) FROM score_snapshots s JOIN (
		SELECT username, MAX(generated_at) AS g FROM score_snapshots WHERE generated_at <= ? AND username IN (` + placeholders + `) GROUP BY username
	) m ON m.username = s.username AND m.g = s.generated_at GROUP BY s.username`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("weekly baselines: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var username string
		var score float64
		if err := rows.Scan(&username, &score); err != nil {
			return nil, err
		}
		baselines[username] = score
	}
	return baselines, rows.Err()
}

func (s *TursoStore) GetProfileReactionState(ctx context.Context, target string, viewerID *int64) (ProfileReactionState, error) {
	state := ProfileReactionState{Counts: emptyProfileReactionCounts()}
	rows, err := s.db.QueryContext(ctx, `SELECT reaction, COUNT(*) FROM profile_reactions WHERE target_username = ? GROUP BY reaction`, target)
	if err != nil {
		return state, fmt.Errorf("read reaction counts: %w", err)
	}
	for rows.Next() {
		var reaction string
		var count int
		if err := rows.Scan(&reaction, &count); err != nil {
			rows.Close()
			return state, err
		}
		switch reaction {
		case string(ReactionLike):
			state.Counts.Like = count
		case string(ReactionPoop):
			state.Counts.Poop = count
		case string(ReactionKick):
			state.Counts.Kick = count
		case string(ReactionFire):
			state.Counts.Fire = count
		case string(ReactionSalute):
			state.Counts.Salute = count
		case string(ReactionClown):
			state.Counts.Clown = count
		}
	}
	if err := rows.Close(); err != nil {
		return state, err
	}
	if viewerID != nil {
		var reaction string
		err := s.db.QueryRowContext(ctx, `SELECT reaction FROM profile_reactions WHERE target_username = ? AND voter_github_id = ?`, target, *viewerID).Scan(&reaction)
		if err == nil {
			if value, ok := validProfileReaction(reaction); ok {
				state.ViewerReaction = &value
			}
		} else if err != sql.ErrNoRows {
			return state, fmt.Errorf("read viewer reaction: %w", err)
		}
	}
	return state, nil
}

func (s *TursoStore) SetProfileReaction(ctx context.Context, target string, githubID int64, login string, reaction ProfileReaction, now time.Time) (ProfileReactionState, error) {
	_, err := s.db.ExecContext(ctx, `INSERT INTO profile_reactions (target_username, voter_github_id, voter_login, reaction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(target_username, voter_github_id) DO UPDATE SET voter_login = excluded.voter_login, reaction = excluded.reaction, updated_at = excluded.updated_at`, target, githubID, login, reaction, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return ProfileReactionState{}, fmt.Errorf("set reaction: %w", err)
	}
	return s.GetProfileReactionState(ctx, target, &githubID)
}

func (s *TursoStore) RemoveProfileReaction(ctx context.Context, target string, githubID int64) (ProfileReactionState, error) {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM profile_reactions WHERE target_username = ? AND voter_github_id = ?`, target, githubID); err != nil {
		return ProfileReactionState{}, fmt.Errorf("remove reaction: %w", err)
	}
	return s.GetProfileReactionState(ctx, target, &githubID)
}

func (s *APIServer) interactionViewer(request *http.Request) *OAuthSession {
	return s.sessionFromRequest(request, s.clock())
}

func interactionUsername(request *http.Request, name string) string {
	return normalizeGitHubUsername(request.PathValue(name))
}

func noStoreHeaders() map[string]string { return map[string]string{"Cache-Control": "no-store"} }

func (s *APIServer) follows(w http.ResponseWriter, request *http.Request) {
	viewer := s.interactionViewer(request)
	if viewer == nil {
		writeJSON(w, http.StatusOK, map[string]any{"accounts": nil}, noStoreHeaders())
		return
	}
	if s.interactions == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "follows_unavailable"}, noStoreHeaders())
		return
	}
	accounts, err := s.interactions.ListFollowedAccounts(request.Context(), viewer.GitHubID, s.clock())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "follows_unavailable"}, noStoreHeaders())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": accounts}, noStoreHeaders())
}

func (s *APIServer) follow(w http.ResponseWriter, request *http.Request) {
	target := interactionUsername(request, "username")
	if target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username"}, noStoreHeaders())
		return
	}
	viewer := s.interactionViewer(request)
	if request.Method == http.MethodGet && viewer == nil {
		writeJSON(w, http.StatusOK, map[string]any{"following": false, "signedIn": false}, noStoreHeaders())
		return
	}
	if viewer == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return
	}
	if s.interactions == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "follows_unavailable"}, noStoreHeaders())
		return
	}
	switch request.Method {
	case http.MethodGet:
		following, err := s.interactions.IsFollowing(request.Context(), viewer.GitHubID, target)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "follows_unavailable"}, noStoreHeaders())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"following": following, "signedIn": true}, noStoreHeaders())
	case http.MethodPut:
		if viewer.Login == target {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot_follow_self"}, noStoreHeaders())
			return
		}
		result, err := s.interactions.SetFollow(request.Context(), viewer.GitHubID, target, s.clock())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "follows_unavailable"}, noStoreHeaders())
			return
		}
		if result == followWriteLimit {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "follow_limit_reached"}, noStoreHeaders())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"following": true}, noStoreHeaders())
	case http.MethodDelete:
		if err := s.interactions.RemoveFollow(request.Context(), viewer.GitHubID, target); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "follows_unavailable"}, noStoreHeaders())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"following": false}, noStoreHeaders())
	}
}

func decodeCommentBody(request *http.Request) (text string, anonymous bool, valid bool) {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 16<<10))
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		return "", false, false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return "", false, false
	}
	body, _ := payload.(map[string]any)
	text = normalizeCommentText(body["text"])
	anonymous, _ = body["anonymous"].(bool)
	return text, anonymous, true
}

func (s *APIServer) commentAuthorFor(request *http.Request, anonymous bool) (CommentAuthor, *int64, bool) {
	if anonymous {
		return CommentAuthor{Type: "anonymous"}, nil, true
	}
	viewer := s.interactionViewer(request)
	if viewer == nil {
		return CommentAuthor{}, nil, false
	}
	var avatar *string
	if viewer.AvatarURL != "" {
		value := viewer.AvatarURL
		avatar = &value
	}
	return CommentAuthor{Type: "github", Username: viewer.Login, AvatarURL: avatar}, &viewer.GitHubID, true
}

func (s *APIServer) profileComments(w http.ResponseWriter, request *http.Request) {
	target := interactionUsername(request, "username")
	if target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username"}, noStoreHeaders())
		return
	}
	if s.interactions == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "comments_unavailable"}, noStoreHeaders())
		return
	}
	if request.Method == http.MethodGet {
		comments, err := s.interactions.ListProfileComments(request.Context(), target)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "comments_unavailable"}, noStoreHeaders())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"comments": comments}, noStoreHeaders())
		return
	}
	text, anonymous, valid := decodeCommentBody(request)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, noStoreHeaders())
		return
	}
	if text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty_comment"}, noStoreHeaders())
		return
	}
	author, authorID, signedIn := s.commentAuthorFor(request, anonymous)
	if !signedIn {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return
	}
	comment, err := s.interactions.CreateProfileComment(request.Context(), target, text, author, authorID, s.clock())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "comments_unavailable"}, noStoreHeaders())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"comment": comment}, noStoreHeaders())
}

func (s *APIServer) profileReactions(w http.ResponseWriter, request *http.Request) {
	target := interactionUsername(request, "username")
	if target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username"}, noStoreHeaders())
		return
	}
	if s.interactions == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "reactions_unavailable"}, noStoreHeaders())
		return
	}
	viewer := s.interactionViewer(request)
	if request.Method == http.MethodGet {
		var viewerID *int64
		if viewer != nil {
			viewerID = &viewer.GitHubID
		}
		state, err := s.interactions.GetProfileReactionState(request.Context(), target, viewerID)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "reactions_unavailable"}, noStoreHeaders())
			return
		}
		writeJSON(w, http.StatusOK, state, noStoreHeaders())
		return
	}
	if viewer == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return
	}
	if request.Method == http.MethodPut {
		decoder := json.NewDecoder(io.LimitReader(request.Body, 16<<10))
		var payload map[string]any
		if err := decoder.Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, noStoreHeaders())
			return
		}
		raw, _ := payload["reaction"].(string)
		reaction, ok := validProfileReaction(raw)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_reaction"}, noStoreHeaders())
			return
		}
		state, err := s.interactions.SetProfileReaction(request.Context(), target, viewer.GitHubID, viewer.Login, reaction, s.clock())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "reactions_unavailable"}, noStoreHeaders())
			return
		}
		writeJSON(w, http.StatusOK, state, noStoreHeaders())
		return
	}
	state, err := s.interactions.RemoveProfileReaction(request.Context(), target, viewer.GitHubID)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "reactions_unavailable"}, noStoreHeaders())
		return
	}
	writeJSON(w, http.StatusOK, state, noStoreHeaders())
}

func (s *APIServer) blogComments(w http.ResponseWriter, request *http.Request) {
	s.contentComments(w, request, false)
}
func (s *APIServer) collectionComments(w http.ResponseWriter, request *http.Request) {
	s.contentComments(w, request, true)
}

func (s *APIServer) contentComments(w http.ResponseWriter, request *http.Request, collection bool) {
	slug := normalizeBlogSlug(request.PathValue("slug"))
	if collection {
		if _, ok := collectionCommentSlugs[slug]; !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid_collection"}, noStoreHeaders())
			return
		}
	} else if _, ok := blogCommentSlugs[slug]; !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid_post"}, noStoreHeaders())
		return
	}
	if s.interactions == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "comments_unavailable"}, noStoreHeaders())
		return
	}
	key := slug
	if collection {
		key = "collection:" + slug
	}
	if request.Method == http.MethodGet {
		comments, err := s.interactions.ListBlogComments(request.Context(), key)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "comments_unavailable"}, noStoreHeaders())
			return
		}
		if collection {
			out := make([]CollectionComment, 0, len(comments))
			for _, comment := range comments {
				out = append(out, CollectionComment{ID: comment.ID, CollectionSlug: slug, Author: comment.Author, Text: comment.Text, CreatedAt: comment.CreatedAt})
			}
			writeJSON(w, http.StatusOK, map[string]any{"comments": out}, noStoreHeaders())
		} else {
			writeJSON(w, http.StatusOK, map[string]any{"comments": comments}, noStoreHeaders())
		}
		return
	}
	text, anonymous, valid := decodeCommentBody(request)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, noStoreHeaders())
		return
	}
	if text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty_comment"}, noStoreHeaders())
		return
	}
	author, authorID, signedIn := s.commentAuthorFor(request, anonymous)
	if !signedIn {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return
	}
	comment, err := s.interactions.CreateBlogComment(request.Context(), key, text, author, authorID, s.clock())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "comments_unavailable"}, noStoreHeaders())
		return
	}
	if collection {
		writeJSON(w, http.StatusCreated, map[string]any{"comment": CollectionComment{ID: comment.ID, CollectionSlug: slug, Author: comment.Author, Text: comment.Text, CreatedAt: comment.CreatedAt}}, noStoreHeaders())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"comment": comment}, noStoreHeaders())
}
