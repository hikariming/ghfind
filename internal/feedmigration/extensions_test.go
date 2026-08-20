package feedmigration

import (
	"context"
	"strings"
	"testing"
)

func TestBootstrapRequiredExtensionsRequiresExplicitAcknowledgement(t *testing.T) {
	err := BootstrapRequiredExtensions(context.Background(), "postgres://unused", "")
	if err == nil || !strings.Contains(err.Error(), "FEED_EXTENSION_BOOTSTRAP_ACK") {
		t.Fatalf("expected acknowledgement error, got %v", err)
	}
}

func TestBootstrapRequiredExtensionsChecksAcknowledgementBeforeDatabaseURL(t *testing.T) {
	err := BootstrapRequiredExtensions(context.Background(), "", "not-the-acknowledgement")
	if err == nil || !strings.Contains(err.Error(), "FEED_EXTENSION_BOOTSTRAP_ACK") {
		t.Fatalf("expected acknowledgement error, got %v", err)
	}
}
