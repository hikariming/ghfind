// Command ghfind-backend dispatches the single backend image to one of the
// role binaries based on GHFIND_ROLE. It exists because Railway applies one
// Dockerfile build per service and the CLI has no start-command setter; the
// api, worker and mocks services all run the same image and select their
// entrypoint through an environment variable.
package main

import (
	"log"
	"os"
	"strings"
	"syscall"
)

func main() {
	role := strings.TrimSpace(os.Getenv("GHFIND_ROLE"))
	if role == "" {
		role = "api"
	}
	binary := map[string]string{
		"api":            "/ghfind-api",
		"worker":         "/ghfind-worker",
		"mocks":          "/ghfind-mocks",
		"feed-bootstrap": "/ghfind-feed-bootstrap",
		"feed-migrate":   "/ghfind-feed-migrate",
	}[role]
	if binary == "" {
		log.Fatalf("unknown GHFIND_ROLE %q", role)
	}
	// Replace the dispatcher instead of spawning a child. The selected service
	// must remain PID 1 so Railway/Docker SIGTERM reaches its graceful HTTP and
	// RabbitMQ shutdown handlers; a parent exec.Command would otherwise exit
	// first and leave the real backend unable to drain in-flight work.
	args := append([]string{binary}, os.Args[1:]...)
	if err := syscall.Exec(binary, args, os.Environ()); err != nil {
		log.Fatalf("exec %s: %v", binary, err)
	}
}
