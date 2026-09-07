package feedbackup

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type ObjectInfo struct {
	Key          string
	Size         int64
	LastModified time.Time
	Metadata     map[string]string
}

type ObjectStore interface {
	Put(context.Context, string, io.Reader, int64, string, map[string]string) error
	Head(context.Context, string) (ObjectInfo, error)
	Get(context.Context, string) (io.ReadCloser, ObjectInfo, error)
	List(context.Context, string) ([]ObjectInfo, error)
	Delete(context.Context, string) error
}

type s3API interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	ListObjectsV2(context.Context, *s3.ListObjectsV2Input, ...func(*s3.Options)) (*s3.ListObjectsV2Output, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

type S3Store struct {
	bucket string
	client s3API
}

func NewS3Store(ctx context.Context, cfg Config) (*S3Store, error) {
	loaded, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(cfg.Region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("load S3 configuration: %w", err)
	}
	client := s3.NewFromConfig(loaded, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(cfg.Endpoint)
		options.UsePathStyle = cfg.UsePathStyle
	})
	return &S3Store{bucket: cfg.Bucket, client: client}, nil
}

func (store *S3Store) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string, metadata map[string]string) error {
	_, err := store.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(store.bucket),
		Key:           aws.String(key),
		Body:          body,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String(contentType),
		Metadata:      metadata,
	})
	if err != nil {
		return fmt.Errorf("put backup object %q: %w", key, err)
	}
	return nil
}

func (store *S3Store) Head(ctx context.Context, key string) (ObjectInfo, error) {
	result, err := store.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(store.bucket), Key: aws.String(key)})
	if err != nil {
		return ObjectInfo{}, fmt.Errorf("head backup object %q: %w", key, err)
	}
	return ObjectInfo{Key: key, Size: aws.ToInt64(result.ContentLength), LastModified: aws.ToTime(result.LastModified), Metadata: result.Metadata}, nil
}

func (store *S3Store) Get(ctx context.Context, key string) (io.ReadCloser, ObjectInfo, error) {
	result, err := store.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(store.bucket), Key: aws.String(key)})
	if err != nil {
		return nil, ObjectInfo{}, fmt.Errorf("get backup object %q: %w", key, err)
	}
	return result.Body, ObjectInfo{
		Key:          key,
		Size:         aws.ToInt64(result.ContentLength),
		LastModified: aws.ToTime(result.LastModified),
		Metadata:     result.Metadata,
	}, nil
}

func (store *S3Store) List(ctx context.Context, prefix string) ([]ObjectInfo, error) {
	objects := make([]ObjectInfo, 0)
	var continuation *string
	for {
		result, err := store.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(store.bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: continuation,
		})
		if err != nil {
			return nil, fmt.Errorf("list backup objects: %w", err)
		}
		for _, object := range result.Contents {
			objects = append(objects, ObjectInfo{
				Key:          aws.ToString(object.Key),
				Size:         aws.ToInt64(object.Size),
				LastModified: aws.ToTime(object.LastModified),
			})
		}
		if !aws.ToBool(result.IsTruncated) || result.NextContinuationToken == nil {
			break
		}
		continuation = result.NextContinuationToken
	}
	return objects, nil
}

func (store *S3Store) Delete(ctx context.Context, key string) error {
	_, err := store.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(store.bucket), Key: aws.String(key)})
	if err != nil {
		return fmt.Errorf("delete backup object %q: %w", key, err)
	}
	return nil
}
