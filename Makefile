GO ?= go
BINDIR ?= bin
DISTDIR ?= dist
CLI_BIN ?= $(BINDIR)/ghfind
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || printf dev)
COMMIT ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || printf none)
BUILD_DATE ?= $(shell git show -s --format=%cI HEAD 2>/dev/null || printf unknown)
LDFLAGS := -X 'github.com/hikariming/ghfind/internal/agentcli.Version=$(VERSION)' \
	-X 'github.com/hikariming/ghfind/internal/agentcli.Commit=$(COMMIT)' \
	-X 'github.com/hikariming/ghfind/internal/agentcli.Date=$(BUILD_DATE)'

.PHONY: cli-build cli-build-all cli-test cli-clean backend-build backend-test

cli-build:
	mkdir -p "$(BINDIR)"
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o "$(CLI_BIN)" ./cmd/ghfind

cli-build-all:
	mkdir -p "$(DISTDIR)"
	GOOS=darwin GOARCH=arm64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o "$(DISTDIR)/ghfind-darwin-arm64" ./cmd/ghfind
	GOOS=darwin GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o "$(DISTDIR)/ghfind-darwin-amd64" ./cmd/ghfind
	GOOS=linux GOARCH=arm64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o "$(DISTDIR)/ghfind-linux-arm64" ./cmd/ghfind
	GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o "$(DISTDIR)/ghfind-linux-amd64" ./cmd/ghfind
	GOOS=windows GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o "$(DISTDIR)/ghfind-windows-amd64.exe" ./cmd/ghfind

cli-test:
	$(GO) test ./internal/agentcli

cli-clean:
	rm -rf "$(BINDIR)" "$(DISTDIR)"

backend-build:
	$(GO) build ./cmd/ghfind-api ./cmd/ghfind-worker

backend-test:
	$(GO) test ./internal/backend
