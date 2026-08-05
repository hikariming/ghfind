// Command ghfind-backend dispatches the single backend image to one of the
// role binaries based on GHFIND_ROLE. It exists because Railway applies one
// Dockerfile build per service and the CLI has no start-command setter; the
// api, worker and mocks services all run the same image and select their
// entrypoint through an environment variable.
package main

import (
	"log"
	"os"
	"os/exec"
	"strings"
)

func main() {
	role := strings.TrimSpace(os.Getenv("GHFIND_ROLE"))
	if role == "" {
		role = "api"
	}
	binary := map[string]string{
		"api":    "/ghfind-api",
		"worker": "/ghfind-worker",
		"mocks":  "/ghfind-mocks",
	}[role]
	if binary == "" {
		log.Fatalf("unknown GHFIND_ROLE %q", role)
	}
	command := exec.Command(binary, os.Args[1:]...)
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = os.Environ()
	if err := command.Run(); err != nil {
		log.Fatalf("%s exited: %v", binary, err)
	}
}
