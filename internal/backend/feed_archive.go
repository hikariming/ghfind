package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

var ErrFeedArchiveErased = errors.New("feed archive erased")
var ErrFeedArchiveConflict = errors.New("feed archive identity conflict")
var archiveIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,120}$`)

type FeedArchiveIdentity struct {
	GitHubID       int64
	ProfileVersion int64
	ArchiveID      string
}

func (id FeedArchiveIdentity) Key() (string, error) {
	if id.GitHubID < 1 || id.ProfileVersion < 1 || !archiveIDPattern.MatchString(id.ArchiveID) {
		return "", errors.New("invalid feed archive identity")
	}
	return fmt.Sprintf("feed/v1/users/%d/%d/%s.json", id.GitHubID, id.ProfileVersion, id.ArchiveID), nil
}

type ArchiveStore interface {
	PutFeedArchive(context.Context, FeedArchiveIdentity, []byte) (string, error)
	GetFeedArchive(context.Context, FeedArchiveIdentity) ([]byte, error)
}

// Erase writes a zero-byte blocker. Immutable puts cannot resurrect old data
// after a cleanup listing or an interrupted archive upload.
type FeedArchiveObjects interface {
	Ping(context.Context) error
	PutImmutable(context.Context, string, []byte, string) error
	Get(context.Context, string) ([]byte, error)
	Erase(context.Context, string) error
}
type FeedS3Config struct {
	Endpoint, Region, Bucket, AccessKeyID, SecretAccessKey string
	UsePathStyle                                           bool
}
type feedS3API interface {
	HeadBucket(context.Context, *s3.HeadBucketInput, ...func(*s3.Options)) (*s3.HeadBucketOutput, error)
	GetBucketVersioning(context.Context, *s3.GetBucketVersioningInput, ...func(*s3.Options)) (*s3.GetBucketVersioningOutput, error)
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
}
type FeedS3Objects struct {
	bucket string
	client feedS3API
}

func NewFeedS3Objects(ctx context.Context, c FeedS3Config) (*FeedS3Objects, error) {
	u, err := url.Parse(c.Endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || c.Bucket == "" || c.Region == "" || c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return nil, errors.New("explicit feed archive S3 configuration required")
	}
	if u.Scheme != "https" && (u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost")) {
		return nil, errors.New("archive S3 requires HTTPS or loopback")
	}
	loaded, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(c.Region), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretAccessKey, "")), awsconfig.WithHTTPClient(&http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}), awsconfig.WithRetryMaxAttempts(2))
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(loaded, func(o *s3.Options) { o.BaseEndpoint = aws.String(c.Endpoint); o.UsePathStyle = c.UsePathStyle })
	return &FeedS3Objects{c.Bucket, client}, nil
}
func (s *FeedS3Objects) Ping(ctx context.Context) error {
	if _, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)}); err != nil {
		return errors.New("archive bucket unavailable")
	}
	v, err := s.client.GetBucketVersioning(ctx, &s3.GetBucketVersioningInput{Bucket: aws.String(s.bucket)})
	if err != nil {
		return errors.New("cannot verify archive bucket versioning")
	}
	if v.Status != "" {
		return errors.New("feed archives require a dedicated unversioned bucket")
	}
	return nil
}
func (s *FeedS3Objects) PutImmutable(ctx context.Context, key string, body []byte, hash string) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), Body: bytes.NewReader(body), ContentLength: aws.Int64(int64(len(body))), ContentType: aws.String("application/json"), IfNoneMatch: aws.String("*"), Metadata: map[string]string{"feed-state": "archive", "sha256": hash}})
	if err == nil {
		return nil
	}
	var response interface{ HTTPStatusCode() int }
	if !errors.As(err, &response) || response.HTTPStatusCode() != 412 {
		return err
	}
	existing, headErr := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if headErr != nil {
		return headErr
	}
	if existing.Metadata["feed-state"] == "erased" {
		return ErrFeedArchiveErased
	}
	if existing.Metadata["sha256"] != hash {
		return ErrFeedArchiveConflict
	}
	return nil
}
func (s *FeedS3Objects) Get(ctx context.Context, key string) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return nil, err
	}
	defer out.Body.Close()
	if out.Metadata["feed-state"] == "erased" {
		return nil, ErrFeedArchiveErased
	}
	body, err := io.ReadAll(io.LimitReader(out.Body, (4<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(body) > 4<<20 {
		return nil, errors.New("archive object too large")
	}
	return body, nil
}
func (s *FeedS3Objects) Erase(ctx context.Context, key string) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), Body: bytes.NewReader(nil), ContentLength: aws.Int64(0), ContentType: aws.String("application/octet-stream"), Metadata: map[string]string{"feed-state": "erased"}})
	return err
}
func (s *PostgresFeedStore) UseArchiveObjects(objects FeedArchiveObjects) error {
	if objects == nil {
		return errors.New("archive objects are required")
	}
	s.archiveObjects = objects
	return nil
}
func (s *PostgresFeedStore) ArchiveReady(ctx context.Context) error {
	if s.archiveObjects == nil {
		return errors.New("archive objects unconfigured")
	}
	return s.archiveObjects.Ping(ctx)
}
func (s *PostgresFeedStore) PutFeedArchive(ctx context.Context, id FeedArchiveIdentity, body []byte) (string, error) {
	key, err := id.Key()
	if err != nil {
		return "", err
	}
	if s.archiveObjects == nil || len(body) > 4<<20 || !json.Valid(body) {
		return "", errors.New("valid bounded archive and object backend required")
	}
	digest := sha256.Sum256(body)
	hash := fmt.Sprintf("%x", digest)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(withFeedProfileVersion(ctx, id.ProfileVersion), tx, id.GitHubID, id.ProfileVersion); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.archive_objects(object_key,github_id,profile_version,payload_hash,status) VALUES($1,$2,$3,$4,'pending') ON CONFLICT(object_key) DO NOTHING`, key, id.GitHubID, id.ProfileVersion, hash); err != nil {
		return "", err
	}
	var storedHash, status string
	if err := tx.QueryRowContext(ctx, `SELECT payload_hash,status FROM feed.archive_objects WHERE object_key=$1`, key).Scan(&storedHash, &status); err != nil {
		return "", err
	}
	if storedHash != hash {
		return "", ErrFeedArchiveConflict
	}
	if status == "erased" {
		return "", ErrFeedArchiveErased
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	if err := s.archiveObjects.PutImmutable(ctx, key, body, hash); err != nil {
		return "", err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE feed.archive_objects SET status='stored' WHERE object_key=$1 AND status<>'erased' AND EXISTS(SELECT 1 FROM feed.users WHERE github_id=$2 AND profile_version=$3 AND deleted_at IS NULL) AND EXISTS(SELECT 1 FROM feed.runtime_control WHERE singleton AND writes_enabled AND writer_epoch=$4)`, key, id.GitHubID, id.ProfileVersion, s.writerEpoch)
	if err != nil {
		return "", err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return "", err
	}
	if changed != 1 {
		return "", ErrFeedProfileChanged
	}
	return key, nil
}
func (s *PostgresFeedStore) GetFeedArchive(ctx context.Context, id FeedArchiveIdentity) ([]byte, error) {
	key, err := id.Key()
	if err != nil {
		return nil, err
	}
	if s.archiveObjects == nil {
		return nil, errors.New("archive objects unconfigured")
	}
	var hash string
	err = s.db.QueryRowContext(ctx, `SELECT a.payload_hash FROM feed.archive_objects a JOIN feed.users u ON u.github_id=a.github_id WHERE a.object_key=$1 AND a.status='stored' AND u.deleted_at IS NULL AND a.profile_version>COALESCE((SELECT MAX(profile_version) FROM feed.user_deletion_tombstones WHERE github_id=a.github_id),0)`, key).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrFeedArchiveErased
	}
	if err != nil {
		return nil, err
	}
	body, err := s.archiveObjects.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(body)
	if !strings.EqualFold(fmt.Sprintf("%x", digest), hash) {
		return nil, ErrFeedArchiveConflict
	}
	var visible bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM feed.archive_objects a JOIN feed.users u ON u.github_id=a.github_id WHERE a.object_key=$1 AND a.status='stored' AND u.deleted_at IS NULL AND a.profile_version>COALESCE((SELECT MAX(profile_version) FROM feed.user_deletion_tombstones WHERE github_id=a.github_id),0))`, key).Scan(&visible); err != nil {
		return nil, err
	}
	if !visible {
		return nil, ErrFeedArchiveErased
	}
	return body, nil
}
