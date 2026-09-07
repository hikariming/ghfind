package backend

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestFeedCursorIsPrincipalBoundAndExpires(t *testing.T) {
	signer, err := NewFeedSigner(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	token, err := signer.SignCursor(FeedCursorClaims{SessionID: "session", GitHubID: 42, Offset: 20, ExpiresAt: now.Add(time.Minute).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := signer.ParseCursor(token, 42, now)
	if err != nil || claims.Offset != 20 {
		t.Fatalf("parse = %#v err=%v", claims, err)
	}
	if _, err := signer.ParseCursor(token, 43, now); !errors.Is(err, ErrInvalidFeedToken) {
		t.Fatalf("cross-user err = %v", err)
	}
	if _, err := signer.ParseCursor(token, 42, now.Add(2*time.Minute)); !errors.Is(err, ErrExpiredFeedToken) {
		t.Fatalf("expired err = %v", err)
	}
	parts := strings.Split(token, ".")
	tampered := "A" + parts[0][1:] + "." + parts[1]
	if _, err := signer.ParseCursor(tampered, 42, now); !errors.Is(err, ErrInvalidFeedToken) {
		t.Fatalf("tampered err = %v", err)
	}
}

func TestFeedImpressionBindsRepoAndAlgorithm(t *testing.T) {
	signer, _ := NewFeedSigner(strings.Repeat("i", 32))
	now := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	token, err := signer.SignImpression(FeedImpressionClaims{GitHubID: 9, RequestID: "feed_1", RepoKey: "Owner/Repo", Rank: 3, AlgorithmVersion: FeedAlgorithmVersion, ExpiresAt: now.Add(time.Hour).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := signer.ParseImpression(token, 9, "owner/repo", now)
	if err != nil || claims.AlgorithmVersion != FeedAlgorithmVersion {
		t.Fatalf("claims=%#v err=%v", claims, err)
	}
	if _, err := signer.ParseImpression(token, 9, "owner/other", now); !errors.Is(err, ErrInvalidFeedToken) {
		t.Fatalf("wrong repo err=%v", err)
	}
}
