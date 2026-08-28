package feedbackup

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultPrefix       = "feed-postgres"
	defaultRetention    = 35 * 24 * time.Hour
	defaultTimeout      = 30 * time.Minute
	defaultChunkSize    = 4 << 20
	restoreConfirmation = "I_UNDERSTAND_THIS_OVERWRITES_THE_TARGET"
)

// Config is intentionally independent from Railway. Railway's private
// PostgreSQL and S3-compatible Bucket are one deployment target; the same
// binary works against any PostgreSQL and S3-compatible object store.
type Config struct {
	DatabaseURL       string
	TargetDatabaseURL string
	EncryptionKey     []byte
	Bucket            string
	Endpoint          string
	Region            string
	AccessKeyID       string
	SecretAccessKey   string
	UsePathStyle      bool
	Prefix            string
	Retention         time.Duration
	Timeout           time.Duration
	ManifestKey       string
	RestoreAck        string
}

func LoadConfig() (Config, error) {
	key, err := decodeEncryptionKey(strings.TrimSpace(os.Getenv("FEED_BACKUP_ENCRYPTION_KEY")))
	if err != nil {
		return Config{}, err
	}

	retention, err := durationEnv("FEED_BACKUP_RETENTION", defaultRetention)
	if err != nil {
		return Config{}, err
	}
	timeout, err := durationEnv("FEED_BACKUP_TIMEOUT", defaultTimeout)
	if err != nil {
		return Config{}, err
	}
	pathStyle, err := s3PathStyleEnv("AWS_S3_URL_STYLE", true)
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		DatabaseURL:       strings.TrimSpace(os.Getenv("FEED_DATABASE_URL")),
		TargetDatabaseURL: strings.TrimSpace(os.Getenv("FEED_RESTORE_TARGET_DATABASE_URL")),
		EncryptionKey:     key,
		Bucket:            firstNonEmpty("AWS_S3_BUCKET_NAME", "BUCKET"),
		Endpoint:          firstNonEmpty("AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3"),
		Region:            firstNonEmpty("AWS_DEFAULT_REGION", "AWS_REGION"),
		AccessKeyID:       strings.TrimSpace(os.Getenv("AWS_ACCESS_KEY_ID")),
		SecretAccessKey:   strings.TrimSpace(os.Getenv("AWS_SECRET_ACCESS_KEY")),
		UsePathStyle:      pathStyle,
		Prefix:            strings.Trim(strings.TrimSpace(os.Getenv("FEED_BACKUP_PREFIX")), "/"),
		Retention:         retention,
		Timeout:           timeout,
		ManifestKey:       strings.TrimSpace(os.Getenv("FEED_BACKUP_MANIFEST_KEY")),
		RestoreAck:        strings.TrimSpace(os.Getenv("FEED_RESTORE_ACK")),
	}
	if cfg.Prefix == "" {
		cfg.Prefix = defaultPrefix
	}
	if cfg.Region == "" {
		cfg.Region = "auto"
	}

	missing := make([]string, 0, 5)
	for name, value := range map[string]string{
		"AWS_S3_BUCKET_NAME":    cfg.Bucket,
		"AWS_ENDPOINT_URL":      cfg.Endpoint,
		"AWS_ACCESS_KEY_ID":     cfg.AccessKeyID,
		"AWS_SECRET_ACCESS_KEY": cfg.SecretAccessKey,
	} {
		if value == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing backup object-store configuration: %s", strings.Join(missing, ", "))
	}
	if cfg.Retention < 24*time.Hour {
		return Config{}, errors.New("FEED_BACKUP_RETENTION must be at least 24h")
	}
	if cfg.Timeout < time.Minute {
		return Config{}, errors.New("FEED_BACKUP_TIMEOUT must be at least 1m")
	}
	return cfg, nil
}

func decodeEncryptionKey(value string) ([]byte, error) {
	if value == "" {
		return nil, errors.New("FEED_BACKUP_ENCRYPTION_KEY is required")
	}
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		decoded, err := encoding.DecodeString(value)
		if err == nil {
			if len(decoded) != 32 {
				return nil, fmt.Errorf("FEED_BACKUP_ENCRYPTION_KEY must decode to 32 bytes, got %d", len(decoded))
			}
			return decoded, nil
		}
	}
	return nil, errors.New("FEED_BACKUP_ENCRYPTION_KEY must be valid base64")
}

func durationEnv(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", name, err)
	}
	return duration, nil
}

func s3PathStyleEnv(name string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	switch strings.ToLower(value) {
	case "path", "path-style":
		return true, nil
	case "virtual", "virtual-host", "virtual-hosted":
		return false, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s: %w", name, err)
	}
	return parsed, nil
}

func firstNonEmpty(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}
