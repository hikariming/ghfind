package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CFFeedArchiveStore uses the executor-only binding capability. It deliberately
// has separate credentials and larger bounded bodies from the Feed API bridge.
type CFFeedArchiveStore struct {
	endpoint, secret string
	epoch            int64
	client           *http.Client
}

func NewCFFeedArchiveStore(endpoint, secret string, epoch int64, client *http.Client) (*CFFeedArchiveStore, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || len(secret) < 32 || epoch < 1 {
		return nil, errors.New("explicit archive endpoint, executor credential and epoch required")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || (u.Hostname() != "feed-archive.internal" && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost")) {
		return nil, errors.New("archive HTTP requires private container handler or loopback")
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	copy := *client
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &CFFeedArchiveStore{strings.TrimRight(endpoint, "/"), secret, epoch, &copy}, nil
}
func (s *CFFeedArchiveStore) call(ctx context.Context, operation string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	if len(body) > 6<<20 {
		return errors.New("archive request exceeds bound")
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint+"/internal/feed/archive/v1/"+operation, bytes.NewReader(body))
	if err != nil {
		return err
	}
	r.Header.Set("Authorization", "Bearer "+s.secret)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Feed-Contract", "1")
	response, err := s.client.Do(r)
	if err != nil {
		return fmt.Errorf("feed archive %s unavailable", operation)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (6<<20)+1))
	if err != nil || len(data) > 6<<20 {
		return errors.New("invalid archive response")
	}
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		switch failure.Error {
		case "writer_epoch_changed":
			return ErrFeedWriterEpoch
		case "profile_version_changed":
			return ErrFeedProfileChanged
		case "archive_not_found":
			return ErrFeedArchiveErased
		case "archive_id_conflict":
			return ErrFeedArchiveConflict
		}
		return fmt.Errorf("feed archive %s returned %d", operation, response.StatusCode)
	}
	if response.Header.Get("X-Feed-Contract") != "1" {
		return errors.New("archive contract version mismatch")
	}
	return json.Unmarshal(data, output)
}
func (s *CFFeedArchiveStore) ArchiveReady(ctx context.Context) error {
	var out struct {
		Ready           bool   `json:"ready"`
		ContractVersion string `json:"contractVersion"`
		WriterEpoch     int64  `json:"writerEpoch"`
	}
	if err := s.call(ctx, "health", struct{}{}, &out); err != nil {
		return err
	}
	if !out.Ready || out.ContractVersion != "1" || out.WriterEpoch != s.epoch {
		return errors.New("archive unavailable or incompatible")
	}
	return nil
}

type feedArchiveCommand struct {
	WriterEpoch    int64  `json:"writerEpoch"`
	GitHubID       int64  `json:"githubId"`
	ProfileVersion int64  `json:"profileVersion"`
	ArchiveID      string `json:"archiveId"`
}

func (s *CFFeedArchiveStore) command(id FeedArchiveIdentity) feedArchiveCommand {
	return feedArchiveCommand{s.epoch, id.GitHubID, id.ProfileVersion, id.ArchiveID}
}
func (s *CFFeedArchiveStore) PutFeedArchive(ctx context.Context, id FeedArchiveIdentity, body []byte) (string, error) {
	key, err := id.Key()
	if err != nil {
		return "", err
	}
	if len(body) > 4<<20 || !json.Valid(body) {
		return "", errors.New("valid bounded JSON archive required")
	}
	in := struct {
		feedArchiveCommand
		Body []byte `json:"bodyBase64"`
	}{s.command(id), body}
	var out struct {
		Key string `json:"key"`
	}
	if err := s.call(ctx, "put", in, &out); err != nil {
		return "", err
	}
	if out.Key != key {
		return "", errors.New("archive identity mismatch")
	}
	return key, nil
}
func (s *CFFeedArchiveStore) GetFeedArchive(ctx context.Context, id FeedArchiveIdentity) ([]byte, error) {
	if _, err := id.Key(); err != nil {
		return nil, err
	}
	var out struct {
		Body []byte `json:"bodyBase64"`
	}
	if err := s.call(ctx, "get", s.command(id), &out); err != nil {
		return nil, err
	}
	if len(out.Body) > 4<<20 || !json.Valid(out.Body) {
		return nil, errors.New("invalid archive JSON response")
	}
	return out.Body, nil
}

var _ ArchiveStore = (*CFFeedArchiveStore)(nil)
var _ ArchiveStore = (*PostgresFeedStore)(nil)
