package backend

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrInvalidFeedToken = errors.New("invalid Feed token")
	ErrExpiredFeedToken = errors.New("expired Feed token")
)

type FeedCursorClaims struct {
	Kind      string `json:"kind"`
	SessionID string `json:"sessionId"`
	GitHubID  int64  `json:"githubId"`
	Offset    int    `json:"offset"`
	ExpiresAt int64  `json:"expiresAt"`
}

type FeedImpressionClaims struct {
	Kind             string `json:"kind"`
	GitHubID         int64  `json:"githubId"`
	RequestID        string `json:"requestId"`
	RepoKey          string `json:"repoKey"`
	Rank             int    `json:"rank"`
	AlgorithmVersion string `json:"algorithmVersion"`
	ExpiresAt        int64  `json:"expiresAt"`
}

type FeedSigner struct{ secret []byte }

func NewFeedSigner(secret string) (*FeedSigner, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("Feed signing secret must contain at least 32 characters")
	}
	return &FeedSigner{secret: []byte(secret)}, nil
}

func (s *FeedSigner) SignCursor(claims FeedCursorClaims) (string, error) {
	claims.Kind = "cursor"
	return s.sign(claims)
}

func (s *FeedSigner) ParseCursor(token string, githubID int64, now time.Time) (FeedCursorClaims, error) {
	var claims FeedCursorClaims
	if err := s.verify(token, &claims); err != nil {
		return claims, err
	}
	if claims.Kind != "cursor" || claims.SessionID == "" || claims.GitHubID != githubID || claims.Offset < 0 {
		return FeedCursorClaims{}, ErrInvalidFeedToken
	}
	if claims.ExpiresAt <= now.UnixMilli() {
		return FeedCursorClaims{}, ErrExpiredFeedToken
	}
	return claims, nil
}

func (s *FeedSigner) SignImpression(claims FeedImpressionClaims) (string, error) {
	claims.Kind = "impression"
	claims.RepoKey = strings.ToLower(strings.TrimSpace(claims.RepoKey))
	return s.sign(claims)
}

func (s *FeedSigner) ParseImpression(token string, githubID int64, repoKey string, now time.Time) (FeedImpressionClaims, error) {
	var claims FeedImpressionClaims
	if err := s.verify(token, &claims); err != nil {
		return claims, err
	}
	if claims.Kind != "impression" || claims.GitHubID != githubID || claims.RequestID == "" ||
		claims.RepoKey != strings.ToLower(strings.TrimSpace(repoKey)) || claims.Rank < 0 {
		return FeedImpressionClaims{}, ErrInvalidFeedToken
	}
	if claims.ExpiresAt <= now.UnixMilli() {
		return FeedImpressionClaims{}, ErrExpiredFeedToken
	}
	return claims, nil
}

func (s *FeedSigner) sign(value any) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(encoded))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded + "." + signature, nil
}

func (s *FeedSigner) verify(token string, target any) error {
	payload, signature, ok := strings.Cut(strings.TrimSpace(token), ".")
	if !ok || payload == "" || signature == "" {
		return ErrInvalidFeedToken
	}
	actual, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return ErrInvalidFeedToken
	}
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(payload))
	expected := mac.Sum(nil)
	if len(actual) != len(expected) || subtle.ConstantTimeCompare(actual, expected) != 1 {
		return ErrInvalidFeedToken
	}
	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil || json.Unmarshal(decoded, target) != nil {
		return ErrInvalidFeedToken
	}
	return nil
}
