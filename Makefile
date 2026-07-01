GO ?= go
BINDIR ?= bin
CLI_BIN ?= $(BINDIR)/github-roast
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || printf dev)
COMMIT ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || printf none)
BUILD_DATE ?= $(shell git show -s --format=%cI HEAD 2>/dev/null || printf unknown)
LDFLAGS := -X 'github.com/hikariming/github-roast/internal/agentcli.Version=$(VERSION)' \
	-X 'github.com/hikariming/github-roast/internal/agentcli.Commit=$(COMMIT)' \
	-X 'github.com/hikariming/github-roast/internal/agentcli.Date=$(BUILD_DATE)'

.PHONY: cli-build cli-test cli-clean

cli-build:
	mkdir -p "$(BINDIR)"
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o "$(CLI_BIN)" ./cmd/github-roast

cli-test:
	$(GO) test ./internal/agentcli

cli-clean:
	rm -rf "$(BINDIR)"
